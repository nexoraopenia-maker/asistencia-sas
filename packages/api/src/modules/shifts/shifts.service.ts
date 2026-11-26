import { db, Prisma, tenantData } from "@scire/database";
import {
  addDays,
  AppError,
  breakMinutes,
  buildSessions,
  durationSeconds,
  ErrorCode,
  intervalMinutes,
  PunchType,
  resolveOperationalDate,
  scheduledMinutesFor,
  ShiftType,
  toZonedDateString,
  toZonedTimeString,
  VerificationStatus,
  WEEKDAY_LABELS_ES,
  weekDaysFrom,
  workedIntervals,
  zonedLocalToUtc,
  type BulkAssignShiftsInput,
  type DaySchedule,
  type ShiftBlock,
  type ShiftInput,
  type UpdateShiftInput,
  type WeeklySchedule,
} from "@scire/shared";
import {
  findShiftSlots,
  getPunchState,
  loadLaborRules,
} from "../../services/workday.service.js";

/**
 * Turnos y calendario.
 *
 * Un turno es un tramo con tipo. La jornada estandar son DOS filas —
 * WORK 09:00:00-18:00:00 y LUNCH 13:00:00-14:00:00 — y no un turno de trabajo
 * con campos de almuerzo dentro. Eso permite jornadas partidas o dobles
 * refrigerios sin tocar el esquema, y hace que el desglose que pide la app
 * salga directo de la consulta.
 */

const dateOnly = (day: string) => new Date(`${day}T00:00:00.000Z`);

function toBlock(shift: {
  id: string;
  type: string;
  startTime: string;
  endTime: string;
}): ShiftBlock {
  return {
    id: shift.id,
    type: shift.type as ShiftType,
    startTime: shift.startTime,
    endTime: shift.endTime,
    durationMinutes: Math.round(durationSeconds(shift.startTime, shift.endTime) / 60),
  };
}

function resolveStatus(input: {
  hasShift: boolean;
  hasPunches: boolean;
  tardiness: number;
  isFuture: boolean;
  hasApprovedAbsence: boolean;
}): DaySchedule["status"] {
  if (!input.hasShift) return "REST";
  if (input.hasApprovedAbsence) return "JUSTIFIED";
  if (input.hasPunches) return input.tardiness > 0 ? "LATE" : "PRESENT";
  return input.isFuture ? "SCHEDULED" : "ABSENT";
}

/**
 * Calendario semanal del empleado (`Dom 12` .. `Sab 18`) con lo programado y
 * lo realmente marcado, dia a dia.
 */
export async function getWeeklySchedule(
  userId: string,
  weekOf: string,
  timezone: string,
): Promise<WeeklySchedule> {
  const days = weekDaysFrom(weekOf);
  const weekStart = days[0]!;
  const weekEnd = days[6]!;
  const today = toZonedDateString(new Date(), timezone);

  const rules = await loadLaborRules();
  const from = dateOnly(weekStart);
  const to = dateOnly(weekEnd);
  // Se leen marcaciones a ambos lados de la semana: la salida del turno noche
  // del sabado ocurre en la semana siguiente.
  const punchFrom = zonedLocalToUtc(addDays(weekStart, -2), "00:00:00", timezone);
  const punchTo = zonedLocalToUtc(addDays(weekEnd, 3), "00:00:00", timezone);

  const [shifts, slots, punches, absences] = await Promise.all([
    db.shift.findMany({
      where: { userId, date: { gte: from, lte: to } },
      select: { id: true, date: true, type: true, startTime: true, endTime: true },
      orderBy: { startTime: "asc" },
    }),
    findShiftSlots(userId, addDays(weekStart, -3), addDays(weekEnd, 3)),
    db.attendanceRecord.findMany({
      where: { userId, isVoided: false, serverTimestamp: { gte: punchFrom, lt: punchTo } },
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
    }),
    db.absence.findMany({
      where: {
        userId,
        status: "APPROVED",
        // Ni las horas extra ni una tardanza o falta injustificada justifican el dia.
        type: { notIn: ["OVERTIME_REQUEST", "JUSTIFIED_TARDINESS", "UNJUSTIFIED_ABSENCE"] },
        startDate: { lte: to },
        endDate: { gte: from },
      },
      select: { startDate: true, endDate: true },
    }),
  ]);

  const shiftsByDay = new Map<string, typeof shifts>();
  for (const shift of shifts) {
    const key = shift.date.toISOString().slice(0, 10);
    (shiftsByDay.get(key) ?? shiftsByDay.set(key, []).get(key)!).push(shift);
  }

  // Las marcaciones se agrupan por jornada (fecha operativa), no por la fecha
  // de calendario en que ocurrieron.
  const workSlots = slots.filter((s) => s.type === ShiftType.WORK);
  const now = new Date();
  const sessions = buildSessions(
    punches.map((p) => ({ ...p, at: p.serverTimestamp })),
    {
      maxShiftHours: rules.maxShiftHours,
      now,
      operationalDateFor: (at) => resolveOperationalDate(at, timezone, workSlots).date,
    },
  );
  const sessionsByDay = new Map<string, typeof sessions>();
  for (const session of sessions) {
    const key = session.operationalDate;
    (sessionsByDay.get(key) ?? sessionsByDay.set(key, []).get(key)!).push(session);
  }

  const totals = {
    scheduledMinutes: 0,
    workedMinutes: 0,
    lunchMinutes: 0,
    tardinessMinutes: 0,
    overtimeMinutes: 0,
  };

  const schedule: DaySchedule[] = days.map((day, index) => {
    const dayShifts = shiftsByDay.get(day) ?? [];
    const daySessions = sessionsByDay.get(day) ?? [];
    const dayPunches = daySessions.flatMap((session) => session.punches);

    const work = dayShifts.find((s) => s.type === ShiftType.WORK);
    const lunch = dayShifts.find((s) => s.type === ShiftType.LUNCH);
    const extra = dayShifts.filter((s) => s !== work && s !== lunch);

    const worked = {
      workedMinutes: daySessions.reduce((sum, s) => sum + intervalMinutes(workedIntervals(s)), 0),
      lunchMinutes: daySessions.reduce((sum, s) => sum + breakMinutes(s), 0),
      complete: daySessions.some((s) => s.status === "CLOSED"),
    };
    const tardiness = dayPunches.reduce((sum, p) => sum + p.tardinessMinutes, 0);

    const hasApprovedAbsence = absences.some(
      (absence) =>
        absence.startDate.toISOString().slice(0, 10) <= day &&
        absence.endDate.toISOString().slice(0, 10) >= day,
    );

    const workBlock = work ? toBlock(work) : null;
    // El refrigerio no es tiempo trabajado: lo programado es el turno de
    // trabajo MENOS el almuerzo, que es exactamente lo que se paga.
    const scheduledMinutes = scheduledMinutesFor(
      day,
      dayShifts.map((s) => ({ ...s, date: day })),
      timezone,
    );

    totals.scheduledMinutes += scheduledMinutes;
    totals.workedMinutes += worked.workedMinutes;
    totals.lunchMinutes += worked.lunchMinutes;
    totals.tardinessMinutes += tardiness;
    if (worked.complete) {
      const limit = work ? scheduledMinutes : rules.dailyOrdinaryMinutes;
      totals.overtimeMinutes += Math.max(0, worked.workedMinutes - limit);
    }

    return {
      date: day,
      weekdayLabel: WEEKDAY_LABELS_ES[index]!,
      dayOfMonth: Number(day.slice(8, 10)),
      isToday: day === today,
      work: workBlock,
      lunch: lunch ? toBlock(lunch) : null,
      extraBlocks: extra.map(toBlock),
      punches: dayPunches.map((punch) => ({
        id: punch.id,
        punchType: punch.punchType as PunchType,
        time: toZonedTimeString(punch.serverTimestamp, timezone),
        serverTimestamp: punch.serverTimestamp.toISOString(),
        isVerified: punch.verificationStatus === VerificationStatus.VERIFIED,
        hasAlert: punch.isMockLocation || punch.isWithinGeofence === false,
      })),
      status: resolveStatus({
        hasShift: Boolean(work),
        hasPunches: dayPunches.length > 0,
        tardiness,
        isFuture: day >= today,
        hasApprovedAbsence,
      }),
      workedMinutes: worked.workedMinutes,
      lunchMinutes: worked.lunchMinutes,
      tardinessMinutes: tardiness,
    };
  });

  // Jornada vigente: puede haber empezado ayer (o en la semana anterior), asi
  // que la app no puede deducirla mirando solo el dia de hoy.
  const state = await getPunchState(userId, now, timezone, rules);
  const currentJornada = {
    date: state.operationalDate,
    isOpen: state.openSession !== null,
    allowedPunches: [...state.allowed],
  };

  return { userId, weekStart, weekEnd, days: schedule, totals, currentJornada };
}

export async function createShift(input: ShiftInput, createdById: string) {
  await assertUserInTenant(input.userId);
  try {
    return await db.shift.create({
      data: tenantData<Prisma.ShiftUncheckedCreateInput>({
        userId: input.userId,
        branchId: input.branchId ?? null,
        date: dateOnly(input.date),
        type: input.type,
        startTime: input.startTime,
        endTime: input.endTime,
        notes: input.notes ?? null,
        createdById,
      }),
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new AppError(ErrorCode.CONFLICT, "Ya existe ese mismo tramo para el empleado en esa fecha");
    }
    throw error;
  }
}

export async function updateShift(input: UpdateShiftInput) {
  const existing = await db.shift.findUnique({ where: { id: input.id }, select: { id: true } });
  if (!existing) throw new AppError(ErrorCode.NOT_FOUND, "Turno no encontrado");

  return db.shift.update({
    where: { id: input.id },
    data: {
      ...(input.date ? { date: dateOnly(input.date) } : {}),
      ...(input.type ? { type: input.type } : {}),
      ...(input.startTime ? { startTime: input.startTime } : {}),
      ...(input.endTime ? { endTime: input.endTime } : {}),
      ...(input.branchId !== undefined ? { branchId: input.branchId ?? null } : {}),
      ...(input.notes !== undefined ? { notes: input.notes ?? null } : {}),
    },
  });
}

export async function deleteShift(shiftId: string) {
  const existing = await db.shift.findUnique({ where: { id: shiftId }, select: { id: true } });
  if (!existing) throw new AppError(ErrorCode.NOT_FOUND, "Turno no encontrado");
  await db.shift.delete({ where: { id: shiftId } });
}

async function assertUserInTenant(userId: string): Promise<void> {
  // La extension de tenant acota este findUnique a la empresa del token, asi
  // que un id de otra empresa devuelve null en vez de la fila ajena.
  const user = await db.user.findUnique({ where: { id: userId }, select: { id: true } });
  if (!user) throw new AppError(ErrorCode.NOT_FOUND, "Empleado no encontrado en tu empresa");
}

/**
 * Asignacion masiva de una plantilla horaria.
 *
 * Genera un tramo por bloque, empleado y dia habil del rango. Con
 * `overwriteExisting` se reemplazan los turnos ya asignados; sin el, los
 * existentes se respetan (`skipDuplicates`), que es lo que RRHH espera al
 * extender una plantilla sobre semanas que ya tienen ajustes manuales.
 */
export async function bulkAssignShifts(input: BulkAssignShiftsInput, createdById: string) {
  const users = await db.user.findMany({
    where: { id: { in: input.userIds } },
    select: { id: true },
  });
  if (users.length !== input.userIds.length) {
    throw new AppError(ErrorCode.NOT_FOUND, "Algun empleado de la lista no pertenece a tu empresa");
  }

  const days: string[] = [];
  for (
    let cursor = dateOnly(input.from);
    cursor <= dateOnly(input.to);
    cursor = new Date(cursor.getTime() + 86_400_000)
  ) {
    if (input.weekdays.includes(cursor.getUTCDay())) {
      days.push(cursor.toISOString().slice(0, 10));
    }
  }

  if (days.length === 0) {
    throw new AppError(
      ErrorCode.VALIDATION_ERROR,
      "El rango de fechas no contiene ninguno de los dias de la semana seleccionados",
    );
  }

  const rows = users.flatMap((user) =>
    days.flatMap((day) =>
      input.blocks.map((block) =>
        tenantData<Prisma.ShiftCreateManyInput>({
          userId: user.id,
          branchId: input.branchId ?? null,
          date: dateOnly(day),
          type: block.type,
          startTime: block.startTime,
          endTime: block.endTime,
          createdById,
        }),
      ),
    ),
  );

  if (input.overwriteExisting) {
    await db.shift.deleteMany({
      where: {
        userId: { in: input.userIds },
        date: { gte: dateOnly(input.from), lte: dateOnly(input.to) },
      },
    });
  }

  const created = await db.shift.createMany({ data: rows, skipDuplicates: true });

  return {
    employees: users.length,
    days: days.length,
    blocksPerDay: input.blocks.length,
    created: created.count,
    skipped: rows.length - created.count,
  };
}
