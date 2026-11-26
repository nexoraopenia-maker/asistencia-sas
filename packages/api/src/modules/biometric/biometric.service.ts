import { randomBytes } from "node:crypto";
import { db, Prisma, requireTenantContext, tenantData } from "@scire/database";
import {
  AppError,
  DEBOUNCED_READ_NOTE,
  DEVICE_STATE_TO_PUNCH,
  ErrorCode,
  parseLocalTimestamp,
  PunchSource,
  PunchType,
  lunchWindow,
  ShiftType,
  toZonedTimeString,
  UserStatus,
  VerificationStatus,
  zonedLocalToUtc,
  type BiometricImportInput,
  type BiometricImportItemResult,
  type BiometricImportResponse,
  type BiometricPunchInput,
  type CreateBiometricDeviceInput,
  type LaborRules,
} from "@scire/shared";
import { loadConfig } from "../../config.js";
import { hashToken } from "../../lib/jwt.js";
import { emitEvent, WebhookEvent } from "../../services/webhooks.service.js";
import {
  getPunchState,
  loadLaborRules,
  type CurrentPunchState,
} from "../../services/workday.service.js";
import { matchShift } from "../punch/punch.service.js";

/**
 * Ingesta de marcaciones de relojes biometricos.
 *
 * Diferencias deliberadas con la marcacion movil:
 *
 * - **Sin geocerca ni selfie.** El reloj esta atornillado en la sucursal y ya
 *   verifico a la persona (huella, rostro, tarjeta). La marcacion nace VERIFIED
 *   y sin coordenadas: `isWithinGeofence` queda null, no `true` inventado.
 * - **El instante lo pone el reloj.** Es la hora en que la persona marco, no la
 *   de llegada al servidor; un log importado al dia siguiente conserva su hora.
 *   `createdAt` sigue guardando el momento real de recepcion.
 * - **El tipo es una pista.** Muchos relojes no distinguen entrada de salida,
 *   y donde si lo hacen la gente pulsa la tecla equivocada. Se usa si encaja en
 *   la secuencia del dia; si no, se deduce.
 *
 * Idempotencia: la clave es `bio:<userId>:<segundo epoch>`. Reenviar el mismo
 * lote, importar el log por USB despues de que el reloj ya lo hubiera enviado,
 * o dos peticiones simultaneas, nunca duplican: el indice unico
 * `(companyId, clientPunchId)` arbitra. Una marcacion ANULADA por RRHH tampoco
 * resucita al reimportar el log, porque su clave sigue ocupada.
 */

const MAX_NOTES_LENGTH = 500;

/** Margen para relojes ligeramente adelantados respecto al servidor. */
const FUTURE_TOLERANCE_MS = 5 * 60_000;

/**
 * Por debajo de esta antigüedad se notifica a n8n / WhatsApp. Una importacion
 * historica no debe disparar cien avisos de tardanza de la semana pasada.
 */
const LIVE_EVENT_WINDOW_MS = 2 * 3_600_000;

export interface BiometricSource {
  /** Reloj que envia. Ausente en la importacion manual de RRHH. */
  deviceId?: string;
  deviceName?: string;
  defaultBranchId?: string | null;
}

interface EmployeeRef {
  id: string;
  employeeCode: string;
  status: string;
}

interface BranchRef {
  id: string;
  name: string;
  timezone: string | null;
  isActive: boolean;
}

/** Item ya resuelto (empleado, sucursal, instante) listo para evaluar. */
interface ResolvedPunch {
  index: number;
  input: BiometricPunchInput;
  user: EmployeeRef;
  branch: BranchRef;
  timezone: string;
  instant: Date;
}

const VERIFY_MODE_LABELS: Record<string, string> = {
  FINGERPRINT: "huella",
  FACE: "rostro",
  CARD: "tarjeta",
  PASSWORD: "clave",
  PALM: "palma",
  OTHER: "otro",
};

function biometricClientId(userId: string, instant: Date): string {
  return `bio:${userId}:${Math.floor(instant.getTime() / 1000)}`;
}

/** Convierte el texto del reloj en un instante, en la zona de la sucursal si viene sin zona. */
function resolveInstant(raw: string, timezone: string): Date {
  const local = parseLocalTimestamp(raw);
  const instant = local ? zonedLocalToUtc(local.date, local.time, timezone) : new Date(raw);
  // Se trunca al segundo: los relojes no tienen mas resolucion, y un conector
  // que anada milisegundos no debe convertir un reenvio en una marcacion nueva.
  return new Date(Math.floor(instant.getTime() / 1000) * 1000);
}

/**
 * Decide el tipo de marcacion.
 *
 * La unica ambiguedad real de la secuencia es despues de una entrada: puede
 * ser el inicio del refrigerio o la salida. Se resuelve con el turno de
 * refrigerio de la jornada: si se marca antes de que termine, es LUNCH_START.
 * Sin turno de refrigerio asignado, es la salida. En un turno nocturno el
 * refrigerio de las 00:30 pertenece a la jornada que empezo la tarde anterior.
 */
function resolvePunchType(
  punch: ResolvedPunch,
  state: CurrentPunchState,
): { punchType: PunchType; hintIgnored: PunchType | null } {
  const { allowed, previous } = state;
  const hint =
    punch.input.punchType ??
    (punch.input.deviceState !== undefined ? DEVICE_STATE_TO_PUNCH[punch.input.deviceState] : undefined);

  if (hint && allowed.includes(hint)) return { punchType: hint, hintIgnored: null };

  if (allowed.length === 0) {
    throw new AppError(
      ErrorCode.INVALID_PUNCH_SEQUENCE,
      "La jornada de ese dia ya tiene la salida registrada",
      { previous, attempted: hint ?? null, allowed },
    );
  }

  let inferred: PunchType;
  if (allowed.length === 1) {
    inferred = allowed[0]!;
  } else {
    const shifts = state.shifts.filter((s) => s.date === state.operationalDate);
    const lunch = shifts.find((s) => s.type === ShiftType.LUNCH);
    const work = shifts.find((s) => s.type === ShiftType.WORK) ?? null;
    const beforeLunchEnds =
      lunch !== undefined &&
      punch.instant < lunchWindow(state.operationalDate, lunch, work, punch.timezone).end;
    inferred = beforeLunchEnds ? PunchType.LUNCH_START : PunchType.OUT;
  }
  return { punchType: inferred, hintIgnored: hint ?? null };
}

/** Si ya hay una marcacion que cubra esta lectura, la devuelve. */
async function findExisting(clientPunchId: string, userId: string, instant: Date) {
  const exact = await db.attendanceRecord.findFirst({
    where: { clientPunchId },
    select: { id: true, punchType: true, serverTimestamp: true, notes: true },
  });
  if (exact) return { ...exact, debounced: false };

  // Doble lectura: el mismo empleado en una ventana corta. Cubre tambien que la
  // misma persona marcara en el movil y en el reloj a la vez.
  const debounceMs = loadConfig().BIOMETRIC_DEBOUNCE_SECONDS * 1000;
  if (debounceMs === 0) return null;
  const near = await db.attendanceRecord.findFirst({
    where: {
      userId,
      isVoided: false,
      serverTimestamp: {
        gte: new Date(instant.getTime() - debounceMs),
        lte: new Date(instant.getTime() + debounceMs),
      },
    },
    select: { id: true, punchType: true, serverTimestamp: true, notes: true },
  });
  return near ? { ...near, debounced: true } : null;
}

/**
 * Deja rastro en la marcacion conservada de la lectura descartada por doble
 * lectura, para que RRHH pueda auditarla. Es idempotente: reenviar el lote no
 * vuelve a escribirla.
 */
async function traceDebouncedRead(
  record: { id: string; serverTimestamp: Date; notes: string | null },
  instant: Date,
  timezone: string,
): Promise<void> {
  if (record.serverTimestamp.getTime() === instant.getTime()) return;
  const mark = `${DEBOUNCED_READ_NOTE} ${toZonedTimeString(instant, timezone)}`;
  const notes = record.notes ?? "";
  if (notes.includes(mark) || notes.length > MAX_NOTES_LENGTH) return;
  await db.attendanceRecord.update({
    where: { id: record.id },
    data: { notes: [notes, mark].filter(Boolean).join(" · ") },
  });
}

async function ingestOne(
  punch: ResolvedPunch,
  source: BiometricSource,
  rules: LaborRules,
): Promise<BiometricImportItemResult> {
  const base = {
    index: punch.index,
    employeeCode: punch.input.employeeCode,
    timestamp: punch.input.timestamp,
  };
  const clientPunchId = biometricClientId(punch.user.id, punch.instant);

  const existing = await findExisting(clientPunchId, punch.user.id, punch.instant);
  if (existing) {
    if (existing.debounced) await traceDebouncedRead(existing, punch.instant, punch.timezone);
    return {
      ...base,
      status: "duplicate",
      recordId: existing.id,
      punchType: existing.punchType as PunchType,
      serverTimestamp: existing.serverTimestamp.toISOString(),
    };
  }

  const state = await getPunchState(punch.user.id, punch.instant, punch.timezone, rules);
  const { punchType, hintIgnored } = resolvePunchType(punch, state);
  const { shiftId, tardiness } = matchShift(
    state,
    punchType,
    punch.instant,
    punch.timezone,
    rules.lateToleranceMinutes,
  );

  const notes = [
    `Reloj biometrico${source.deviceName ? ` "${source.deviceName}"` : " (importacion manual)"}`,
    punch.input.verifyMode ? VERIFY_MODE_LABELS[punch.input.verifyMode] : null,
    punch.input.deviceLogId ? `log ${punch.input.deviceLogId}` : null,
    hintIgnored ? `el reloj indico ${hintIgnored}, no encajaba tras ${state.previous}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  let record;
  try {
    record = await db.attendanceRecord.create({
      data: tenantData<Prisma.AttendanceRecordUncheckedCreateInput>({
        userId: punch.user.id,
        branchId: punch.branch.id,
        shiftId,
        punchType,
        source: PunchSource.BIOMETRIC,
        serverTimestamp: punch.instant,
        deviceTimestamp: punch.instant,
        clockSkewSeconds: 0,
        verificationStatus: VerificationStatus.VERIFIED,
        tardinessMinutes: tardiness,
        clientPunchId,
        biometricDeviceId: source.deviceId ?? null,
        notes,
      }),
      select: { id: true },
    });
  } catch (error) {
    // Carrera con otra peticion que traia la misma lectura: gana el indice unico.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const duplicate = await findExisting(clientPunchId, punch.user.id, punch.instant);
      return { ...base, status: "duplicate", recordId: duplicate?.id };
    }
    throw error;
  }

  if (Date.now() - punch.instant.getTime() < LIVE_EVENT_WINDOW_MS) {
    const payload = {
      recordId: record.id,
      userId: punch.user.id,
      punchType,
      at: punch.instant.toISOString(),
      branch: punch.branch.name,
      source: PunchSource.BIOMETRIC,
    };
    await emitEvent(WebhookEvent.PUNCH_CREATED, payload);
    if (tardiness > 0) {
      await emitEvent(WebhookEvent.PUNCH_LATE, { ...payload, tardinessMinutes: tardiness });
    }
  }

  return {
    ...base,
    status: "created",
    recordId: record.id,
    punchType,
    serverTimestamp: punch.instant.toISOString(),
  };
}

/**
 * Procesa un lote de lecturas del reloj.
 *
 * Igual que el lote offline del movil: se evalua por elementos (una lectura de
 * un DNI desconocido no tumba las demas) y en orden cronologico, porque el
 * tipo deducido depende de lo que ya se marco ese dia.
 */
export async function importBiometricPunches(
  input: BiometricImportInput,
  source: BiometricSource,
): Promise<BiometricImportResponse> {
  requireTenantContext();
  const config = loadConfig();
  const now = Date.now();

  const branchIds = new Set(
    input.punches.map((p) => p.branchId ?? source.defaultBranchId).filter((id): id is string => !!id),
  );
  const codes = [...new Set(input.punches.map((p) => p.employeeCode))];

  const [company, users, branches] = await Promise.all([
    loadLaborRules(),
    db.user.findMany({
      where: { employeeCode: { in: codes } },
      select: { id: true, employeeCode: true, status: true },
    }),
    db.branch.findMany({
      where: { id: { in: [...branchIds] } },
      select: { id: true, name: true, timezone: true, isActive: true },
    }),
  ]);
  const userByCode = new Map(users.map((u) => [u.employeeCode, u]));
  const branchById = new Map(branches.map((b) => [b.id, b]));

  const results: BiometricImportItemResult[] = [];
  const resolved: ResolvedPunch[] = [];

  input.punches.forEach((punchInput, index) => {
    const reject = (code: ErrorCode, message: string) =>
      results.push({
        index,
        employeeCode: punchInput.employeeCode,
        timestamp: punchInput.timestamp,
        status: "rejected",
        error: { code, message },
      });

    const user = userByCode.get(punchInput.employeeCode);
    if (!user) {
      return reject(
        ErrorCode.NOT_FOUND,
        `No hay ningun empleado con codigo "${punchInput.employeeCode}" en la empresa`,
      );
    }
    // INVITED se acepta: quien solo ficha en el reloj quiza nunca active la app.
    if (user.status !== UserStatus.ACTIVE && user.status !== UserStatus.INVITED) {
      return reject(ErrorCode.USER_SUSPENDED, `El empleado ${user.employeeCode} no esta activo`);
    }

    const branchId = punchInput.branchId ?? source.defaultBranchId;
    if (!branchId) {
      return reject(
        ErrorCode.VALIDATION_ERROR,
        "Indica branchId: el dispositivo no tiene una sucursal asignada",
      );
    }
    const branch = branchById.get(branchId);
    if (!branch || !branch.isActive) {
      return reject(ErrorCode.NOT_FOUND, "La sucursal indicada no existe o esta inactiva");
    }

    const timezone = branch.timezone ?? company.timezone;
    const instant = resolveInstant(punchInput.timestamp, timezone);
    if (Number.isNaN(instant.getTime())) {
      return reject(ErrorCode.VALIDATION_ERROR, "Fecha y hora invalidas");
    }
    if (instant.getTime() > now + FUTURE_TOLERANCE_MS) {
      return reject(
        ErrorCode.CLOCK_SKEW_TOO_LARGE,
        "La marcacion tiene una fecha futura: revisa la hora y la zona del reloj",
      );
    }
    if (now - instant.getTime() > config.BIOMETRIC_MAX_AGE_DAYS * 86_400_000) {
      return reject(
        ErrorCode.CLOCK_SKEW_TOO_LARGE,
        `La marcacion tiene mas de ${config.BIOMETRIC_MAX_AGE_DAYS} dias: debe regularizarla RRHH`,
      );
    }

    resolved.push({ index, input: punchInput, user, branch, timezone, instant });
  });

  resolved.sort((a, b) => a.instant.getTime() - b.instant.getTime() || a.index - b.index);

  for (const punch of resolved) {
    try {
      results.push(await ingestOne(punch, source, company));
    } catch (error) {
      const appError =
        error instanceof AppError
          ? error
          : new AppError(ErrorCode.INTERNAL_ERROR, "No se pudo registrar la marcacion");
      if (!(error instanceof AppError)) console.error("[biometric] error al importar", error);
      results.push({
        index: punch.index,
        employeeCode: punch.input.employeeCode,
        timestamp: punch.input.timestamp,
        status: "rejected",
        error: { code: appError.code, message: appError.message },
      });
    }
  }

  results.sort((a, b) => a.index - b.index);
  return {
    results,
    created: results.filter((r) => r.status === "created").length,
    duplicates: results.filter((r) => r.status === "duplicate").length,
    rejected: results.filter((r) => r.status === "rejected").length,
  };
}

// =============================================================================
// Gestion de dispositivos (RRHH)
// =============================================================================

const DEVICE_SELECT = {
  id: true,
  name: true,
  serialNumber: true,
  tokenPrefix: true,
  isActive: true,
  lastSeenAt: true,
  revokedAt: true,
  createdAt: true,
  branch: { select: { id: true, name: true } },
} satisfies Prisma.BiometricDeviceSelect;

export async function listDevices() {
  return db.biometricDevice.findMany({ select: DEVICE_SELECT, orderBy: { createdAt: "desc" } });
}

/** Da de alta un reloj y devuelve su token en claro UNA sola vez. */
export async function createDevice(input: CreateBiometricDeviceInput) {
  if (input.branchId) {
    const branch = await db.branch.findUnique({
      where: { id: input.branchId },
      select: { isActive: true },
    });
    if (!branch?.isActive) {
      throw new AppError(ErrorCode.NOT_FOUND, "La sucursal indicada no existe o esta inactiva");
    }
  }

  const token = `scire_dev_${randomBytes(32).toString("base64url")}`;
  try {
    const device = await db.biometricDevice.create({
      data: tenantData<Prisma.BiometricDeviceUncheckedCreateInput>({
        name: input.name,
        serialNumber: input.serialNumber ?? null,
        branchId: input.branchId ?? null,
        tokenHash: hashToken(token),
        tokenPrefix: token.slice(0, 14),
      }),
      select: DEVICE_SELECT,
    });
    return { device, token };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new AppError(ErrorCode.CONFLICT, "Ya existe un dispositivo con ese nombre");
    }
    throw error;
  }
}

export async function revokeDevice(deviceId: string) {
  const result = await db.biometricDevice.updateMany({
    where: { id: deviceId, revokedAt: null },
    data: { isActive: false, revokedAt: new Date() },
  });
  if (result.count === 0) {
    throw new AppError(ErrorCode.NOT_FOUND, "Dispositivo no encontrado o ya revocado");
  }
}
