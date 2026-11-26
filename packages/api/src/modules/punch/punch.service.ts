import { db, Prisma, requireTenantContext, tenantData, withAuditReason } from "@scire/database";
import {
  addDays,
  AppError,
  buildSessions,
  VALID_PUNCH_TRANSITIONS,
  type ManualPunchInput,
  Feature,
  hasFeature,
  type SubscriptionTier,
  checkGeofence,
  clockSkewSeconds,
  ErrorCode,
  PunchSource,
  PunchType,
  lateMinutesFrom,
  resolveOperationalDate,
  ShiftType,
  shiftWindow,
  toZonedTimeString,
  VerificationStatus,
  zonedLocalToUtc,
  type AdjustPunchInput,
  type BatchPunchInput,
  type BatchPunchItemResult,
  type BatchPunchResponse,
  type CreatePunchInput,
  type PresignedUrlRequest,
  type PresignedUrlResponse,
  type PunchResult,
  type VoidPunchInput,
} from "@scire/shared";
import { loadConfig } from "../../config.js";
import {
  buildSelfieKey,
  createPresignedDownload,
  createPresignedUpload,
  objectExists,
} from "../../lib/storage.js";
import { emitEvent, WebhookEvent } from "../../services/webhooks.service.js";
import {
  findShiftSlots,
  getPunchState,
  loadLaborRules,
  type CurrentPunchState,
} from "../../services/workday.service.js";

/**
 * Marcacion de asistencia.
 *
 * El flujo completo desde el movil son dos llamadas:
 *   1. POST /punch/presigned-url  -> firma la subida de la selfie a S3/R2
 *   2. PUT  <uploadUrl>           -> el movil sube la foto DIRECTAMENTE
 *   3. POST /punch                -> confirma la marcacion citando la clave
 *
 * La foto nunca pasa por la API. Ademas de ahorrar ancho de banda, evita que
 * una marcacion masiva a las 9:00 sature el servidor con binarios.
 */

/** Datos de la empresa y la sucursal que gobiernan la validacion. */
interface PunchContext {
  company: {
    id: string;
    timezone: string;
    lateToleranceMinutes: number;
    maxShiftHours: number;
    allowSplitShifts: boolean;
    requireSelfie: boolean;
    requireGeofence: boolean;
    faceMatchEnabled: boolean;
    tier: string;
  };
  branch: {
    id: string;
    name: string;
    latitude: number;
    longitude: number;
    radiusMeters: number;
    timezone: string | null;
  };
}

/**
 * Decide si la marcacion debe quedar pendiente de verificacion facial.
 *
 * Cuando el face-match esta activo, la marcacion NO se da por verificada al
 * crearla: queda `PENDING` y el trabajador de biometria la resuelve en
 * segundos. Verificarla antes y corregirla despues significaria que RRHH ve un
 * "Verificado" que puede convertirse en "Sospechoso" un momento mas tarde.
 */
function needsFaceMatch(company: PunchContext["company"], selfieKey?: string): boolean {
  return Boolean(
    selfieKey &&
      company.faceMatchEnabled &&
      hasFeature(company.tier as SubscriptionTier, Feature.FACE_MATCH),
  );
}

async function loadContext(branchId: string): Promise<PunchContext> {
  // El tenant ya esta resuelto por el middleware: no hace falta releer el
  // usuario para averiguar su empresa. Es el camino caliente de la marcacion,
  // asi que cada consulta que se ahorra cuenta.
  const { companyId } = requireTenantContext();

  const [company, branch] = await Promise.all([
    db.company.findUnique({
      where: { id: companyId },
      select: {
        id: true,
        timezone: true,
        lateToleranceMinutes: true,
        maxShiftHours: true,
        allowSplitShifts: true,
        requireSelfie: true,
        requireGeofence: true,
        faceMatchEnabled: true,
        tier: true,
      },
    }),
    // La extension de tenant acota este findUnique a la empresa del token:
    // una sucursal de otra empresa devuelve null, no la fila ajena.
    db.branch.findUnique({
      where: { id: branchId },
      select: {
        id: true,
        name: true,
        latitude: true,
        longitude: true,
        radiusMeters: true,
        timezone: true,
        isActive: true,
      },
    }),
  ]);

  if (!company) throw new AppError(ErrorCode.NOT_FOUND, "Empresa no encontrada");
  if (!branch || !branch.isActive) {
    throw new AppError(ErrorCode.NOT_FOUND, "La sucursal indicada no existe o esta inactiva");
  }

  return { company, branch };
}

/** Zona horaria efectiva: la de la sucursal si la tiene, si no la de la empresa. */
function effectiveTimezone(ctx: PunchContext): string {
  return ctx.branch.timezone ?? ctx.company.timezone;
}

/**
 * Comprueba que la secuencia de marcaciones tiene sentido.
 *
 * Sin esto, un empleado podria registrar dos entradas seguidas y acumular
 * horas que no trabajo, o cerrar un refrigerio que nunca empezo. La secuencia
 * se evalua sobre la SESION abierta, no sobre el dia de calendario: la salida
 * de las 02:00 cierra la entrada de las 20:00 del dia anterior.
 */
async function assertValidSequence(
  userId: string,
  instant: Date,
  timezone: string,
  company: PunchContext["company"],
  punchType: PunchType,
): Promise<CurrentPunchState> {
  const state = await getPunchState(userId, instant, timezone, company);

  if (!state.allowed.includes(punchType)) {
    const { previous, allowed } = state;
    const expected = allowed.length > 0 ? allowed.join(" o ") : "ninguna marcacion mas hoy";
    throw new AppError(
      ErrorCode.INVALID_PUNCH_SEQUENCE,
      `No puedes registrar "${punchType}" ahora. Tu ultima marcacion fue "${previous}"; corresponde: ${expected}.`,
      { previous, attempted: punchType, allowed },
    );
  }
  return state;
}

/**
 * Turno de referencia y tardanza de una marcacion dentro de su jornada.
 * Para una entrada se compara contra el INSTANTE de inicio del turno, de modo
 * que llegar a las 00:10 a un turno de las 23:00 son 70 minutos y no cero.
 */
export function matchShift(
  state: CurrentPunchState,
  punchType: PunchType,
  instant: Date,
  timezone: string,
  lateToleranceMinutes: number,
): { shiftId: string | null; tardiness: number } {
  const sameDate = state.shifts.filter((s) => s.date === state.operationalDate);
  if (punchType === PunchType.IN) {
    const match = resolveOperationalDate(instant, timezone, state.shifts);
    const shift = match.date === state.operationalDate ? match.shift : null;
    if (!shift) return { shiftId: null, tardiness: 0 };
    const { start } = shiftWindow(shift.date, shift.startTime, shift.endTime, timezone);
    return {
      shiftId: shift.id ?? null,
      tardiness: lateMinutesFrom(instant, start, lateToleranceMinutes),
    };
  }
  const isLunch = punchType === PunchType.LUNCH_START || punchType === PunchType.LUNCH_END;
  const shift = sameDate.find((s) => s.type === (isLunch ? ShiftType.LUNCH : ShiftType.WORK));
  return { shiftId: shift?.id ?? null, tardiness: 0 };
}

/** Turno de un tipo asignado en una fecha operativa, si lo hay. */
export async function findShift(userId: string, localDate: string, type: "WORK" | "LUNCH") {
  return db.shift.findFirst({
    where: { userId, date: new Date(`${localDate}T00:00:00.000Z`), type },
    select: { id: true, startTime: true, endTime: true },
  });
}

export interface EvaluatedPunch {
  data: Prisma.AttendanceRecordUncheckedCreateInput;
  result: Omit<PunchResult, "recordId">;
  alerts: { late: boolean; mockLocation: boolean; outsideGeofence: boolean };
}

/**
 * Aplica todas las reglas de negocio y devuelve la fila lista para insertar.
 *
 * Es una funcion pura respecto a la escritura: la usan por igual la marcacion
 * individual y el lote offline, de modo que ambos caminos aplican exactamente
 * las mismas validaciones. Un lote no es una puerta trasera para saltarse la
 * geocerca.
 */
export async function evaluatePunch(
  userId: string,
  input: CreatePunchInput,
  ctx: PunchContext,
): Promise<EvaluatedPunch> {
  const config = loadConfig();
  const timezone = effectiveTimezone(ctx);
  const now = new Date();
  const deviceTimestamp = new Date(input.deviceTimestamp);
  const isOffline = input.source === PunchSource.MOBILE_OFFLINE;

  // --- Instante efectivo de la marcacion ---------------------------------
  // Online: manda el reloj del servidor, que es el que tiene validez legal.
  // Offline: manda el reloj del dispositivo, porque el empleado fichó cuando
  // fichó, no cuando el movil recupero cobertura. `createdAt` conserva de
  // todos modos el momento real de recepcion, asi que no se pierde el rastro.
  let serverTimestamp = now;
  if (isOffline) {
    const ageHours = (now.getTime() - deviceTimestamp.getTime()) / 3_600_000;
    if (deviceTimestamp > now) {
      throw new AppError(
        ErrorCode.CLOCK_SKEW_TOO_LARGE,
        "La marcacion encolada tiene una fecha futura: revisa el reloj del dispositivo",
      );
    }
    if (ageHours > config.MAX_OFFLINE_AGE_HOURS) {
      throw new AppError(
        ErrorCode.CLOCK_SKEW_TOO_LARGE,
        `La marcacion es demasiado antigua (${Math.round(ageHours)} h). Debe regularizarla RRHH.`,
      );
    }
    serverTimestamp = deviceTimestamp;
  }

  const skew = clockSkewSeconds(deviceTimestamp, now);

  // --- Secuencia ----------------------------------------------------------
  const state = await assertValidSequence(
    userId,
    serverTimestamp,
    timezone,
    ctx.company,
    input.punchType,
  );

  // --- Geocerca -----------------------------------------------------------
  const geofence = checkGeofence({
    point: { latitude: input.location.latitude, longitude: input.location.longitude },
    center: { latitude: ctx.branch.latitude, longitude: ctx.branch.longitude },
    radiusMeters: ctx.branch.radiusMeters,
    accuracyMeters: input.location.accuracyMeters ?? null,
    bufferMeters: config.GEOFENCE_ACCURACY_BUFFER_M,
  });

  if (ctx.company.requireGeofence && !geofence.isInside) {
    throw new AppError(
      ErrorCode.OUTSIDE_GEOFENCE,
      `Estas a ${Math.round(geofence.distanceMeters)} m de ${ctx.branch.name}. Acercate al area autorizada para marcar.`,
      { distanceMeters: geofence.distanceMeters, radiusMeters: geofence.effectiveRadiusMeters },
    );
  }

  // --- GPS simulado -------------------------------------------------------
  // El flag lo reporta el propio dispositivo (Android `isFromMockProvider`):
  // es una senal, no una prueba. Se registra SIEMPRE. Que se rechace o se
  // acepte como sospechosa lo decide la empresa via REJECT_MOCK_LOCATION,
  // porque en algunos parques de dispositivos hay falsos positivos y bloquear
  // a un empleado que no puede fichar es peor que revisarlo despues.
  const isMock = input.location.isMockLocation;
  if (isMock && config.REJECT_MOCK_LOCATION) {
    throw new AppError(
      ErrorCode.MOCK_LOCATION_DETECTED,
      "Se detecto una ubicacion simulada. Desactiva las apps de ubicacion falsa para poder marcar.",
    );
  }

  // --- Selfie -------------------------------------------------------------
  if (ctx.company.requireSelfie && !input.selfieObjectKey) {
    throw new AppError(
      ErrorCode.SELFIE_REQUIRED,
      "Tu empresa exige una selfie para validar la marcacion",
    );
  }
  if (input.selfieObjectKey) {
    // La clave debe estar bajo el prefijo del tenant: impide citar el objeto
    // de otra empresa aunque se conociera su ruta.
    if (!input.selfieObjectKey.startsWith(`punches/${ctx.company.id}/`)) {
      throw new AppError(ErrorCode.FORBIDDEN, "La clave de la selfie no pertenece a tu empresa");
    }
    // Se comprueba que la foto llego de verdad al bucket: pedir la URL firmada
    // y no subir nada dejaria una marcacion "con foto" apuntando a la nada.
    const uploaded = await objectExists(input.selfieObjectKey);
    if (!uploaded) {
      throw new AppError(
        ErrorCode.SELFIE_NOT_UPLOADED,
        "No encontramos la selfie en el almacenamiento. Vuelve a tomarla.",
      );
    }
  }

  // --- Puntualidad --------------------------------------------------------
  const { shiftId, tardiness } = matchShift(
    state,
    input.punchType,
    serverTimestamp,
    timezone,
    ctx.company.lateToleranceMinutes,
  );

  // --- Estado de verificacion --------------------------------------------
  // El face-match (FASE 7) rellenara faceMatchScore de forma asincrona; hasta
  // entonces una marcacion limpia queda VERIFIED y una con senales de fraude
  // queda SUSPICIOUS para que RRHH la revise en el feed del dashboard.
  const suspicious =
    isMock ||
    !geofence.isInside ||
    (!isOffline && Math.abs(skew) > config.MAX_ONLINE_CLOCK_SKEW_SECONDS);

  // El orden importa: una senal de fraude (GPS falso, fuera de geocerca) gana
  // sobre la verificacion facial pendiente. No tiene sentido esperar a
  // Rekognition para marcar como sospechosa una marcacion que ya lo es.
  const verificationStatus = suspicious
    ? VerificationStatus.SUSPICIOUS
    : needsFaceMatch(ctx.company, input.selfieObjectKey)
      ? VerificationStatus.PENDING
      : VerificationStatus.VERIFIED;

  return {
    data: {
      companyId: ctx.company.id,
      userId,
      branchId: ctx.branch.id,
      shiftId,
      punchType: input.punchType,
      source: input.source,
      serverTimestamp,
      deviceTimestamp,
      clockSkewSeconds: skew,
      selfieObjectKey: input.selfieObjectKey ?? null,
      latitude: input.location.latitude,
      longitude: input.location.longitude,
      accuracyMeters: input.location.accuracyMeters ?? null,
      altitudeMeters: input.location.altitudeMeters ?? null,
      distanceMeters: geofence.distanceMeters,
      isWithinGeofence: geofence.isInside,
      isMockLocation: isMock,
      verificationStatus,
      tardinessMinutes: tardiness,
      clientPunchId: input.clientPunchId,
      notes: input.notes ?? null,
    },
    result: {
      punchType: input.punchType,
      serverTimestamp: serverTimestamp.toISOString(),
      deviceTimestamp: deviceTimestamp.toISOString(),
      clockSkewSeconds: skew,
      verificationStatus,
      geofence: {
        isInside: geofence.isInside,
        distanceMeters: geofence.distanceMeters,
        branchName: ctx.branch.name,
      },
      isMockLocation: isMock,
      faceMatchScore: null,
      tardinessMinutes: tardiness,
    },
    alerts: {
      late: tardiness > 0,
      mockLocation: isMock,
      outsideGeofence: !geofence.isInside,
    },
  };
}

/** Notifica a n8n / Evolution API lo que RRHH necesita saber al momento. */
async function emitPunchEvents(
  evaluated: EvaluatedPunch,
  recordId: string,
  userId: string,
): Promise<void> {
  const base = {
    recordId,
    userId,
    punchType: evaluated.result.punchType,
    at: evaluated.result.serverTimestamp,
    branch: evaluated.result.geofence.branchName,
  };

  await emitEvent(WebhookEvent.PUNCH_CREATED, base);
  if (evaluated.alerts.late) {
    await emitEvent(WebhookEvent.PUNCH_LATE, {
      ...base,
      tardinessMinutes: evaluated.result.tardinessMinutes,
    });
  }
  if (evaluated.alerts.mockLocation) {
    await emitEvent(WebhookEvent.PUNCH_MOCK_LOCATION, base);
  }
  if (evaluated.alerts.outsideGeofence) {
    await emitEvent(WebhookEvent.PUNCH_OUTSIDE_GEOFENCE, {
      ...base,
      distanceMeters: evaluated.result.geofence.distanceMeters,
    });
  }
}

/** Marcacion existente con el mismo clientPunchId, si la hay. */
async function findByClientId(clientPunchId: string) {
  return db.attendanceRecord.findFirst({
    where: { clientPunchId },
    select: { id: true, punchType: true, serverTimestamp: true },
  });
}

export async function requestPresignedUrl(
  userId: string,
  companyId: string,
  input: PresignedUrlRequest,
): Promise<PresignedUrlResponse> {
  const objectKey = buildSelfieKey({
    companyId,
    userId,
    punchType: input.punchType,
    contentType: input.contentType,
  });

  return createPresignedUpload({
    objectKey,
    contentType: input.contentType,
    contentLength: input.contentLength,
  });
}

export async function createPunch(userId: string, input: CreatePunchInput): Promise<PunchResult> {
  const existing = await findByClientId(input.clientPunchId);
  if (existing) {
    throw new AppError(ErrorCode.DUPLICATE_PUNCH, "Esta marcacion ya fue registrada", {
      recordId: existing.id,
    });
  }

  const ctx = await loadContext(input.branchId);
  const evaluated = await evaluatePunch(userId, input, ctx);

  let record;
  try {
    record = await db.attendanceRecord.create({
      data: evaluated.data,
      select: { id: true },
    });
  } catch (error) {
    // Dos peticiones simultaneas con el mismo clientPunchId: el indice unico
    // hace de arbitro. La segunda no crea nada y recibe DUPLICATE_PUNCH.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const duplicate = await findByClientId(input.clientPunchId);
      throw new AppError(ErrorCode.DUPLICATE_PUNCH, "Esta marcacion ya fue registrada", {
        recordId: duplicate?.id,
      });
    }
    throw error;
  }

  await emitPunchEvents(evaluated, record.id, userId);

  return { recordId: record.id, ...evaluated.result };
}

/**
 * Sincronizacion de la cola offline del movil.
 *
 * Dos decisiones de diseno importan aqui:
 *
 * 1. **Se procesa por elementos, no como transaccion unica.** Una marcacion
 *    invalida en el lote (fuera de geocerca, secuencia rota) no puede tirar
 *    las 20 buenas que la acompanan. Cada una recibe su veredicto.
 * 2. **Se ordena por `deviceTimestamp` antes de procesar.** La validacion de
 *    secuencia depende del orden real de los hechos; si el movil envia el lote
 *    desordenado, un LUNCH_END podria evaluarse antes que su LUNCH_START.
 *
 * La respuesta detalla el resultado de cada `clientPunchId` para que el
 * dispositivo pueda vaciar de su cola solo lo confirmado.
 */
export async function createPunchBatch(
  userId: string,
  input: BatchPunchInput,
): Promise<BatchPunchResponse> {
  const ordered = [...input.punches].sort(
    (a, b) => new Date(a.deviceTimestamp).getTime() - new Date(b.deviceTimestamp).getTime(),
  );

  const results: BatchPunchItemResult[] = [];
  let created = 0;
  let duplicates = 0;
  let rejected = 0;

  for (const punch of ordered) {
    try {
      const result = await createPunch(userId, {
        ...punch,
        source: PunchSource.MOBILE_OFFLINE,
      });
      results.push({ clientPunchId: punch.clientPunchId, status: "created", recordId: result.recordId });
      created++;
    } catch (error) {
      if (error instanceof AppError && error.code === ErrorCode.DUPLICATE_PUNCH) {
        // Ya estaba registrada: para el movil es un exito, puede borrarla de
        // la cola. Es el caso normal cuando se pierde la respuesta de red.
        results.push({
          clientPunchId: punch.clientPunchId,
          status: "duplicate",
          recordId: error.details?.recordId as string | undefined,
        });
        duplicates++;
        continue;
      }

      const appError =
        error instanceof AppError
          ? error
          : new AppError(ErrorCode.INTERNAL_ERROR, "No se pudo registrar la marcacion");

      results.push({
        clientPunchId: punch.clientPunchId,
        status: "rejected",
        error: { code: appError.code, message: appError.message },
      });
      rejected++;
    }
  }

  return { results, created, duplicates, rejected };
}

/**
 * Marcaciones de la jornada en curso del propio empleado (modal "Detalle del
 * Turno"). Si hay una sesion abierta que empezo ayer, es esa la jornada.
 */
export async function getTodayPunches(userId: string, timezone: string) {
  const rules = await loadLaborRules();
  const state = await getPunchState(userId, new Date(), timezone, rules);
  const ids = state.sessions
    .filter((session) => session.operationalDate === state.operationalDate)
    .flatMap((session) => session.punches.map((punch) => punch.id!));

  const records = await db.attendanceRecord.findMany({
    where: { userId, id: { in: ids } },
    select: {
      id: true,
      punchType: true,
      serverTimestamp: true,
      verificationStatus: true,
      isMockLocation: true,
      isWithinGeofence: true,
      tardinessMinutes: true,
    },
    orderBy: { serverTimestamp: "asc" },
  });

  return records.map((record) => ({
    id: record.id,
    punchType: record.punchType,
    time: toZonedTimeString(record.serverTimestamp, timezone),
    serverTimestamp: record.serverTimestamp.toISOString(),
    isVerified: record.verificationStatus === VerificationStatus.VERIFIED,
    hasAlert: record.isMockLocation || record.isWithinGeofence === false,
    tardinessMinutes: record.tardinessMinutes,
  }));
}

export interface ListPunchesQuery {
  userId?: string;
  branchId?: string;
  from?: string;
  to?: string;
  onlyAlerts?: boolean;
  page: number;
  pageSize: number;
}

/** Feed del dashboard de RRHH. */
export async function listPunches(query: ListPunchesQuery) {
  // `from`/`to` son fechas de la empresa: en Lima, el dia termina a las 05:00
  // UTC del siguiente. Filtrar por fecha UTC esconderia el turno noche.
  const { timezone } = await loadLaborRules();
  const where: Prisma.AttendanceRecordWhereInput = {
    ...(query.userId ? { userId: query.userId } : {}),
    ...(query.branchId ? { branchId: query.branchId } : {}),
    ...(query.from || query.to
      ? {
          serverTimestamp: {
            ...(query.from ? { gte: zonedLocalToUtc(query.from, "00:00:00", timezone) } : {}),
            ...(query.to
              ? { lt: zonedLocalToUtc(addDays(query.to, 1), "00:00:00", timezone) }
              : {}),
          },
        }
      : {}),
    ...(query.onlyAlerts
      ? {
          OR: [
            { isMockLocation: true },
            { isWithinGeofence: false },
            { verificationStatus: VerificationStatus.SUSPICIOUS },
            { tardinessMinutes: { gt: 0 } },
          ],
        }
      : {}),
  };

  const [items, total] = await Promise.all([
    db.attendanceRecord.findMany({
      where,
      select: {
        id: true,
        punchType: true,
        source: true,
        serverTimestamp: true,
        deviceTimestamp: true,
        clockSkewSeconds: true,
        verificationStatus: true,
        isMockLocation: true,
        isWithinGeofence: true,
        distanceMeters: true,
        tardinessMinutes: true,
        faceMatchScore: true,
        isVoided: true,
        selfieObjectKey: true,
        user: { select: { id: true, fullName: true, employeeCode: true, jobTitle: true } },
        branch: { select: { id: true, name: true } },
      },
      orderBy: { serverTimestamp: "desc" },
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
    db.attendanceRecord.count({ where }),
  ]);

  return {
    // La clave del objeto no sale al cliente: se expone solo un booleano y la
    // URL firmada se pide aparte, con su propia comprobacion de permisos.
    items: items.map(({ selfieObjectKey, ...rest }) => ({
      ...rest,
      hasSelfie: Boolean(selfieObjectKey),
      serverTimestamp: rest.serverTimestamp.toISOString(),
      deviceTimestamp: rest.deviceTimestamp.toISOString(),
    })),
    page: query.page,
    pageSize: query.pageSize,
    total,
    totalPages: Math.ceil(total / query.pageSize),
  };
}

/** URL firmada de vida corta para ver la selfie desde el dashboard. */
export async function getSelfieUrl(recordId: string) {
  const record = await db.attendanceRecord.findUnique({
    where: { id: recordId },
    select: { selfieObjectKey: true },
  });
  if (!record?.selfieObjectKey) {
    throw new AppError(ErrorCode.NOT_FOUND, "Esta marcacion no tiene selfie asociada");
  }
  return createPresignedDownload(record.selfieObjectKey);
}

/**
 * Correccion manual de RRHH.
 *
 * `withAuditReason` adjunta el motivo; la extension de auditoria escribe la
 * entrada en `AuditLog` sola. No hay forma de editar una marcacion sin dejar
 * rastro, ni siquiera olvidandose.
 */
export async function adjustPunch(input: AdjustPunchInput) {
  const record = await db.attendanceRecord.findUnique({
    where: { id: input.recordId },
    select: { id: true, isVoided: true },
  });
  if (!record) throw new AppError(ErrorCode.NOT_FOUND, "Marcacion no encontrada");
  if (record.isVoided) {
    throw new AppError(ErrorCode.CONFLICT, "No se puede editar una marcacion anulada");
  }

  return withAuditReason({ reason: input.reason }, () =>
    db.attendanceRecord.update({
      where: { id: input.recordId },
      data: {
        ...(input.serverTimestamp ? { serverTimestamp: new Date(input.serverTimestamp) } : {}),
        ...(input.punchType ? { punchType: input.punchType } : {}),
        verificationStatus: input.verificationStatus ?? VerificationStatus.MANUAL_OVERRIDE,
      },
      select: {
        id: true,
        punchType: true,
        serverTimestamp: true,
        verificationStatus: true,
        tardinessMinutes: true,
      },
    }),
  );
}

/**
 * Anulacion. Nunca borra la fila: un registro con valor legal laboral no se
 * elimina, se marca como anulado y queda visible en la auditoria.
 */
export async function voidPunch(input: VoidPunchInput, actorUserId: string) {
  const record = await db.attendanceRecord.findUnique({
    where: { id: input.recordId },
    select: { id: true, isVoided: true },
  });
  if (!record) throw new AppError(ErrorCode.NOT_FOUND, "Marcacion no encontrada");
  if (record.isVoided) {
    throw new AppError(ErrorCode.CONFLICT, "La marcacion ya estaba anulada");
  }

  return withAuditReason({ reason: input.reason }, () =>
    db.attendanceRecord.update({
      where: { id: input.recordId },
      data: { isVoided: true, voidedAt: new Date(), voidedById: actorUserId },
      select: { id: true, isVoided: true, voidedAt: true },
    }),
  );
}

/**
 * Regularizacion de RRHH: crea una marcacion que falta.
 *
 * Se valida sobre la sesion resultante y no sobre "la ultima marcacion": lo
 * normal es insertar una salida en medio del historial, dias despues.
 */
export async function createManualPunch(input: ManualPunchInput, actorUserId: string) {
  const rules = await loadLaborRules();
  const user = await db.user.findUnique({
    where: { id: input.userId },
    select: { id: true, branchId: true },
  });
  if (!user) throw new AppError(ErrorCode.NOT_FOUND, "Empleado no encontrado en tu empresa");

  const branchId = input.branchId ?? user.branchId;
  if (!branchId) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, "Indica la sucursal de la marcacion");
  }
  const branch = await db.branch.findUnique({
    where: { id: branchId },
    select: { timezone: true },
  });
  if (!branch) throw new AppError(ErrorCode.NOT_FOUND, "La sucursal indicada no existe");

  const timezone = branch.timezone ?? rules.timezone;
  const time = input.time.length === 5 ? `${input.time}:00` : input.time;
  const instant = zonedLocalToUtc(input.date, time, timezone);
  if (instant.getTime() > Date.now()) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, "No se puede registrar una marcacion futura");
  }

  const margin = (rules.maxShiftHours + 48) * 3_600_000;
  const [records, shifts] = await Promise.all([
    db.attendanceRecord.findMany({
      where: {
        userId: user.id,
        isVoided: false,
        serverTimestamp: {
          gte: new Date(instant.getTime() - margin),
          lte: new Date(instant.getTime() + margin),
        },
      },
      select: { id: true, punchType: true, serverTimestamp: true },
    }),
    findShiftSlots(user.id, addDays(input.date, -4), input.date),
  ]);

  const CANDIDATE = "candidate";
  const sessions = buildSessions(
    [
      ...records.map((r) => ({ id: r.id, punchType: r.punchType, at: r.serverTimestamp })),
      { id: CANDIDATE, punchType: input.punchType, at: instant },
    ],
    {
      maxShiftHours: rules.maxShiftHours,
      now: new Date(),
      operationalDateFor: (at) => resolveOperationalDate(at, timezone, shifts).date,
    },
  );
  const session = sessions.find((s) => s.punches.some((p) => p.id === CANDIDATE))!;
  const types = session.punches.map((p) => p.punchType as PunchType);
  const isOrdered = types.every((type, i) =>
    VALID_PUNCH_TRANSITIONS[i === 0 ? "NONE" : types[i - 1]!].includes(type),
  );
  if (session.status === "ORPHAN" || !isOrdered) {
    throw new AppError(
      ErrorCode.INVALID_PUNCH_SEQUENCE,
      `La marcacion no encaja en la jornada (quedaria: ${types.join(", ")}). Revisa la hora o anula la marcacion erronea.`,
    );
  }

  const shift = resolveOperationalDate(instant, timezone, shifts);
  const sameDate = shifts.filter((s) => s.date === session.operationalDate);
  const isLunch = input.punchType === PunchType.LUNCH_START || input.punchType === PunchType.LUNCH_END;
  const matched = sameDate.find((s) => s.type === (isLunch ? ShiftType.LUNCH : ShiftType.WORK));
  const tardiness =
    input.punchType === PunchType.IN && shift.window && shift.date === session.operationalDate
      ? lateMinutesFrom(instant, shift.window.start, rules.lateToleranceMinutes)
      : 0;

  let record;
  try {
    record = await db.attendanceRecord.create({
      data: tenantData<Prisma.AttendanceRecordUncheckedCreateInput>({
        userId: user.id,
        branchId,
        shiftId: matched?.id ?? null,
        punchType: input.punchType,
        source: PunchSource.MANUAL,
        serverTimestamp: instant,
        deviceTimestamp: instant,
        verificationStatus: VerificationStatus.MANUAL_OVERRIDE,
        tardinessMinutes: tardiness,
        clientPunchId: `manual:${user.id}:${instant.getTime() / 1000}:${input.punchType}`,
        notes: `Regularizacion de RRHH: ${input.reason}`,
      }),
      select: { id: true, punchType: true, serverTimestamp: true, tardinessMinutes: true },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new AppError(ErrorCode.DUPLICATE_PUNCH, "Esa marcacion ya fue regularizada");
    }
    throw error;
  }

  // La extension de auditoria solo cubre cambios; el alta manual se deja aqui.
  await db.auditLog.create({
    data: tenantData<Prisma.AuditLogUncheckedCreateInput & { companyId: string }>({
      entityType: "AttendanceRecord",
      recordId: record.id,
      action: "CREATE",
      modifiedByUserId: actorUserId,
      newValue: {
        userId: user.id,
        punchType: input.punchType,
        serverTimestamp: instant.toISOString(),
      },
      reason: input.reason,
    }),
  });

  return { ...record, serverTimestamp: record.serverTimestamp.toISOString() };
}
