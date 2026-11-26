import { db, requireTenantContext } from "@scire/database";
import {
  addDays,
  buildSessions,
  resolveOperationalDate,
  resolvePunchState,
  ShiftType,
  toZonedDateString,
  type LaborRules,
  type PunchState,
  type ShiftSlot,
  type WorkSession,
} from "@scire/shared";

/**
 * Puente entre la base de datos y el motor de jornadas de `@scire/shared`.
 *
 * La marcacion movil, el reloj biometrico y el calendario preguntan aqui "en
 * que jornada estoy", de modo que ninguno vuelve a cortar el dia a las 00:00.
 */

/** Columnas de `Company` que gobiernan el calculo laboral. */
export const LABOR_RULES_SELECT = {
  timezone: true,
  lateToleranceMinutes: true,
  earlyLeaveToleranceMinutes: true,
  maxShiftHours: true,
  allowSplitShifts: true,
  dailyOrdinaryMinutes: true,
  weeklyOrdinaryMinutes: true,
  overtimeThresholdMinutes: true,
  overtimeTier1Minutes: true,
  overtimeTier1RatePct: true,
  overtimeTier2RatePct: true,
  nightStartTime: true,
  nightEndTime: true,
  nightSurchargePct: true,
  nightShiftMinSharePct: true,
  minimumWage: true,
  hourlyDivisor: true,
  payrollCurrency: true,
} as const;

/** Reglas de la empresa actual. `minimumWage` sale como numero, no como Decimal. */
export async function loadLaborRules(): Promise<LaborRules> {
  // `Company` NO esta en la extension de tenant: sin este `where` se leerian
  // las reglas de otra empresa.
  const company = await db.company.findUniqueOrThrow({
    where: { id: requireTenantContext().companyId },
    select: LABOR_RULES_SELECT,
  });
  return {
    ...company,
    minimumWage: company.minimumWage === null ? null : Number(company.minimumWage),
  };
}

export type ShiftSlotRow = ShiftSlot & { id: string };

/** Turnos de un empleado entre dos fechas operativas (inclusive). */
export async function findShiftSlots(
  userId: string,
  from: string,
  to: string,
): Promise<ShiftSlotRow[]> {
  const rows = await db.shift.findMany({
    where: {
      userId,
      date: { gte: new Date(`${from}T00:00:00.000Z`), lte: new Date(`${to}T00:00:00.000Z`) },
    },
    select: { id: true, date: true, type: true, startTime: true, endTime: true },
    orderBy: [{ date: "asc" }, { startTime: "asc" }],
  });
  return rows.map((row) => ({ ...row, date: row.date.toISOString().slice(0, 10) }));
}

export interface CurrentPunchState extends PunchState {
  /** Turnos de la fecha operativa y sus vecinas, para resolver tardanza y refrigerio. */
  shifts: ShiftSlotRow[];
  sessions: WorkSession[];
}

/**
 * Estado de la jornada de un empleado en un instante: ultima marcacion de la
 * sesion abierta (aunque empezara ayer), transiciones permitidas y fecha
 * operativa a la que pertenecera la siguiente marcacion.
 */
export async function getPunchState(
  userId: string,
  instant: Date,
  timezone: string,
  rules: Pick<LaborRules, "maxShiftHours" | "allowSplitShifts">,
): Promise<CurrentPunchState> {
  const localDate = toZonedDateString(instant, timezone);
  // Holgura de dos dias sobre el plazo maximo: basta para ver la sesion abierta
  // y las ya cerradas de la fecha operativa anterior.
  const since = new Date(instant.getTime() - (rules.maxShiftHours + 48) * 3_600_000);

  const [records, shifts] = await Promise.all([
    db.attendanceRecord.findMany({
      where: { userId, isVoided: false, serverTimestamp: { gte: since, lte: instant } },
      select: { id: true, punchType: true, serverTimestamp: true },
      orderBy: { serverTimestamp: "asc" },
    }),
    findShiftSlots(userId, addDays(localDate, -4), localDate),
  ]);
  const workShifts = shifts.filter((s) => s.type === ShiftType.WORK);
  const operationalDateFor = (at: Date) => resolveOperationalDate(at, timezone, workShifts).date;

  const sessions = buildSessions(
    records.map((r) => ({ id: r.id, punchType: r.punchType, at: r.serverTimestamp })),
    { maxShiftHours: rules.maxShiftHours, now: instant, operationalDateFor },
  );
  const newSessionDate = operationalDateFor(instant);
  const state = resolvePunchState({
    sessions,
    newSessionDate,
    workShiftsOnNewDate: workShifts.filter((s) => s.date === newSessionDate).length,
    allowSplitShifts: rules.allowSplitShifts,
  });

  return { ...state, shifts, sessions };
}
