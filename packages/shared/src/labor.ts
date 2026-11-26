/**
 * Calculo laboral de una jornada: horas ordinarias, sobretiempo por tramos,
 * horario nocturno e incidencias auditables.
 *
 * Valores por defecto: Peru, regimen laboral general de la actividad privada.
 * - Jornada ordinaria maxima: 8 h diarias o 48 h semanales
 *   (Constitucion art. 25; D.S. 007-2002-TR, art. 1).
 * - Sobretiempo: recargo minimo del 25 % del valor hora para las dos primeras
 *   horas y del 35 % para las restantes (D.S. 007-2002-TR, art. 10). Se debe
 *   aunque no haya autorizacion expresa si el trabajo se presto con
 *   conocimiento del empleador: por eso el sistema lo CALCULA siempre y solo
 *   marca como incidencia la falta de solicitud aprobada.
 * - Trabajo nocturno: de 22:00 a 06:00. El trabajador nocturno no puede
 *   percibir menos que la RMV con una sobretasa del 35 % (D.S. 007-2002-TR,
 *   art. 8). Es un PISO de remuneracion, no un recargo automatico por hora: el
 *   sistema informa las horas nocturnas y la referencia sobre la RMV, y la
 *   planilla decide si la remuneracion del trabajador ya cubre el piso.
 *
 * Supuestos documentados (configurables, validalos con tu asesor laboral):
 * - El limite diario de sobretiempo es la jornada PROGRAMADA del dia (turno
 *   menos refrigerio). Sin turno se usa `dailyOrdinaryMinutes`.
 * - El refrigerio no es tiempo de trabajo y no computa ni como ordinario ni
 *   como nocturno.
 * - El exceso semanal sobre `weeklyOrdinaryMinutes` (no cubierto ya por el
 *   sobretiempo diario) se REPORTA como incidencia pero no se valoriza: su
 *   tratamiento depende de como la empresa distribuye la jornada.
 * - "Jornada nocturna" = al menos `nightShiftMinSharePct` % del tiempo
 *   trabajado cae en horario nocturno. Es un criterio interno de reporte.
 * - El valor hora de referencia es remuneracion mensual / `hourlyDivisor`
 *   (30 dias x 8 h = 240).
 */

import { VerificationStatus } from "./enums.js";
import { toZonedDateString } from "./time.js";
import {
  addDays,
  breakMinutes,
  intervalMinutes,
  lunchWindow,
  nightMinutes,
  shiftWindow,
  splitOvertime,
  workedIntervals,
  type PunchLike,
  type ShiftSlot,
  type WorkSession,
} from "./workday.js";

export interface LaborRules {
  timezone: string;
  lateToleranceMinutes: number;
  earlyLeaveToleranceMinutes: number;
  maxShiftHours: number;
  allowSplitShifts: boolean;
  dailyOrdinaryMinutes: number;
  weeklyOrdinaryMinutes: number;
  overtimeThresholdMinutes: number;
  overtimeTier1Minutes: number;
  overtimeTier1RatePct: number;
  overtimeTier2RatePct: number;
  nightStartTime: string;
  nightEndTime: string;
  nightSurchargePct: number;
  nightShiftMinSharePct: number;
  /** RMV vigente; null si la empresa no la configuro. */
  minimumWage: number | null;
  hourlyDivisor: number;
  payrollCurrency: string;
}

/** RMV de Peru vigente desde el 01/10/2026 (D.S. 015-2026-TR). */
export const PERU_MINIMUM_WAGE = 1230;

/** Valores por defecto (Peru, regimen general). Coinciden con los del esquema. */
export const DEFAULT_LABOR_RULES: Omit<LaborRules, "timezone"> = {
  lateToleranceMinutes: 10,
  earlyLeaveToleranceMinutes: 10,
  maxShiftHours: 16,
  allowSplitShifts: false,
  dailyOrdinaryMinutes: 480,
  weeklyOrdinaryMinutes: 2880,
  overtimeThresholdMinutes: 0,
  overtimeTier1Minutes: 120,
  overtimeTier1RatePct: 25,
  overtimeTier2RatePct: 35,
  nightStartTime: "22:00:00",
  nightEndTime: "06:00:00",
  nightSurchargePct: 35,
  nightShiftMinSharePct: 50,
  minimumWage: PERU_MINIMUM_WAGE,
  hourlyDivisor: 240,
  payrollCurrency: "PEN",
};

/** Marca que deja el reloj biometrico en la marcacion al descartar una doble lectura. */
export const DEBOUNCED_READ_NOTE = "lectura repetida descartada";

/** Dos marcaciones consecutivas mas juntas que esto se senalan como posible duplicado. */
export const NEAR_DUPLICATE_SECONDS = 120;

export const IncidentCode = {
  /** Entrada sin salida pasado `maxShiftHours`. No se inventan horas. */
  MISSING_OUT: "MISSING_OUT",
  /** Salida o refrigerio sin entrada previa. */
  ORPHAN_PUNCH: "ORPHAN_PUNCH",
  /** Refrigerio iniciado y nunca cerrado. */
  OPEN_BREAK: "OPEN_BREAK",
  LATE: "LATE",
  EARLY_LEAVE: "EARLY_LEAVE",
  ABSENT: "ABSENT",
  OUTSIDE_GEOFENCE: "OUTSIDE_GEOFENCE",
  MOCK_LOCATION: "MOCK_LOCATION",
  SUSPICIOUS: "SUSPICIOUS",
  /** Dos marcaciones casi simultaneas (doble toque, movil + reloj). */
  NEAR_DUPLICATE: "NEAR_DUPLICATE",
  /** El reloj envio lecturas repetidas que se descartaron. */
  DEBOUNCED_READ: "DEBOUNCED_READ",
  /** Trabajo en un dia sin turno asignado (posible descanso o feriado). */
  UNSCHEDULED_WORK: "UNSCHEDULED_WORK",
  /** Sobretiempo sin solicitud aprobada que lo cubra. Se paga igual. */
  OVERTIME_NOT_AUTHORIZED: "OVERTIME_NOT_AUTHORIZED",
  /** Exceso sobre la jornada semanal no cubierto por el sobretiempo diario. */
  WEEKLY_EXCESS: "WEEKLY_EXCESS",
} as const;
export type IncidentCode = (typeof IncidentCode)[keyof typeof IncidentCode];

export interface Incident {
  code: IncidentCode;
  message: string;
  punchIds?: string[];
}

export interface JornadaPunch extends PunchLike {
  id: string;
  source?: string;
  tardinessMinutes: number;
  isMockLocation: boolean;
  isWithinGeofence: boolean | null;
  verificationStatus?: string;
  notes?: string | null;
}

export interface JornadaInput {
  date: string;
  sessions: readonly WorkSession<JornadaPunch>[];
  /** Turnos (WORK y LUNCH) con esta fecha operativa. */
  shifts: readonly ShiftSlot[];
  rules: LaborRules;
  /** Minutos de sobretiempo aprobados para el dia; null si no hay solicitud. */
  approvedOvertimeMinutes: number | null;
  /** Hay una ausencia aprobada (licencia, vacaciones...) que cubre el dia. */
  hasApprovedAbsence: boolean;
  /** Descripcion de las ausencias aprobadas del dia. */
  justifications?: string[];
  /** Hay una tardanza justificada aprobada. */
  tardinessJustified?: boolean;
  /** Hoy en la zona de la empresa: los dias futuros no cuentan como falta. */
  today: string;
}

export interface SessionDetail {
  inAt: string | null;
  outAt: string | null;
  status: WorkSession["status"];
  workedMinutes: number;
  breakMinutes: number;
  nightMinutes: number;
  crossesMidnight: boolean;
  punches: {
    id: string;
    punchType: string;
    at: string;
    source?: string;
  }[];
}

export interface JornadaMetrics {
  date: string;
  scheduledMinutes: number;
  /** Trabajado efectivo (sin refrigerio) de las sesiones cerradas. */
  workedMinutes: number;
  lunchMinutes: number;
  ordinaryMinutes: number;
  overtimeMinutes: number;
  overtimeTier1Minutes: number;
  overtimeTier2Minutes: number;
  overtimeAuthorizedMinutes: number | null;
  nightMinutes: number;
  isNightShift: boolean;
  crossesMidnight: boolean;
  tardinessMinutes: number;
  earlyLeaveMinutes: number;
  hasShift: boolean;
  hasPunches: boolean;
  isComplete: boolean;
  isAbsent: boolean;
  isJustified: boolean;
  isLate: boolean;
  incidents: Incident[];
  sessions: SessionDetail[];
  /** Ausencias aprobadas que cubren el dia, ya legibles ("Descanso medico: ..."). */
  justifications: string[];
}

function workShifts(shifts: readonly ShiftSlot[]) {
  return shifts.filter((s) => s.type === "WORK");
}

/** Minutos programados: tramos de trabajo menos refrigerios, sobre instantes. */
export function scheduledMinutesFor(
  date: string,
  shifts: readonly ShiftSlot[],
  timeZone: string,
): number {
  const work = workShifts(shifts);
  if (work.length === 0) return 0;
  const workMs = work.reduce((sum, s) => {
    const w = shiftWindow(date, s.startTime, s.endTime, timeZone);
    return sum + (w.end.getTime() - w.start.getTime());
  }, 0);
  const lunchMs = shifts
    .filter((s) => s.type === "LUNCH")
    .reduce((sum, s) => {
      const w = lunchWindow(date, s, work[0]!, timeZone);
      return sum + (w.end.getTime() - w.start.getTime());
    }, 0);
  return Math.max(0, Math.round((workMs - lunchMs) / 60_000));
}

export function computeJornada(input: JornadaInput): JornadaMetrics {
  const { rules, date } = input;
  const tz = rules.timezone;
  const incidents: Incident[] = [];
  const work = workShifts(input.shifts);
  const scheduledMinutes = scheduledMinutesFor(date, input.shifts, tz);

  let workedMinutes = 0;
  let lunchMinutes = 0;
  let night = 0;
  let crossesMidnight = false;
  const sessions: SessionDetail[] = [];
  const allPunches: JornadaPunch[] = [];

  for (const session of input.sessions) {
    const intervals = workedIntervals(session);
    const worked = intervalMinutes(intervals);
    const sessionNight = nightMinutes(intervals, tz, rules.nightStartTime, rules.nightEndTime);
    const breaks = breakMinutes(session);
    const crosses = Boolean(
      session.inAt &&
        session.outAt &&
        toZonedDateString(session.inAt, tz) !== toZonedDateString(session.outAt, tz),
    );

    workedMinutes += worked;
    lunchMinutes += breaks;
    night += sessionNight;
    crossesMidnight ||= crosses;
    allPunches.push(...session.punches);

    const ids = session.punches.map((p) => p.id);
    if (session.status === "MISSING_OUT") {
      incidents.push({
        code: IncidentCode.MISSING_OUT,
        message: "Entrada sin salida: la jornada no suma horas hasta que RRHH la regularice",
        punchIds: ids,
      });
    } else if (session.status === "ORPHAN") {
      incidents.push({
        code: IncidentCode.ORPHAN_PUNCH,
        message: "Marcacion sin entrada previa",
        punchIds: ids,
      });
    }
    if (session.breaks.some((b) => b.end === null) && session.status !== "OPEN") {
      incidents.push({ code: IncidentCode.OPEN_BREAK, message: "Refrigerio sin cierre", punchIds: ids });
    }

    sessions.push({
      inAt: session.inAt?.toISOString() ?? null,
      outAt: session.outAt?.toISOString() ?? null,
      status: session.status,
      workedMinutes: worked,
      breakMinutes: breaks,
      nightMinutes: sessionNight,
      crossesMidnight: crosses,
      punches: session.punches.map((p) => ({
        id: p.id,
        punchType: String(p.punchType),
        at: p.at.toISOString(),
        ...(p.source ? { source: p.source } : {}),
      })),
    });
  }

  // --- Senales por marcacion ----------------------------------------------
  const flagged = (predicate: (p: JornadaPunch) => boolean) =>
    allPunches.filter(predicate).map((p) => p.id);
  const outside = flagged((p) => p.isWithinGeofence === false);
  if (outside.length) {
    incidents.push({ code: IncidentCode.OUTSIDE_GEOFENCE, message: "Marcacion fuera de geocerca", punchIds: outside });
  }
  const mock = flagged((p) => p.isMockLocation);
  if (mock.length) {
    incidents.push({ code: IncidentCode.MOCK_LOCATION, message: "Ubicacion simulada", punchIds: mock });
  }
  const suspicious = flagged((p) => p.verificationStatus === VerificationStatus.SUSPICIOUS);
  if (suspicious.length) {
    incidents.push({ code: IncidentCode.SUSPICIOUS, message: "Marcacion sospechosa pendiente de revision", punchIds: suspicious });
  }
  const debounced = flagged((p) => Boolean(p.notes?.includes(DEBOUNCED_READ_NOTE)));
  if (debounced.length) {
    incidents.push({
      code: IncidentCode.DEBOUNCED_READ,
      message: "El reloj envio lecturas repetidas que se descartaron (ver nota de la marcacion)",
      punchIds: debounced,
    });
  }
  const sorted = [...allPunches].sort((a, b) => a.at.getTime() - b.at.getTime());
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]!.at.getTime() - sorted[i - 1]!.at.getTime() < NEAR_DUPLICATE_SECONDS * 1000) {
      incidents.push({
        code: IncidentCode.NEAR_DUPLICATE,
        message: "Dos marcaciones casi simultaneas: revisa si fue un doble registro",
        punchIds: [sorted[i - 1]!.id, sorted[i]!.id],
      });
    }
  }

  // --- Puntualidad ----------------------------------------------------------
  const tardiness = allPunches.reduce((sum, p) => sum + p.tardinessMinutes, 0);
  if (tardiness > 0) {
    incidents.push({
      code: IncidentCode.LATE,
      message: `Tardanza de ${tardiness} min${input.tardinessJustified ? " (justificada)" : ""}`,
    });
  }

  const closed = input.sessions.filter((s) => s.status === "CLOSED");
  let earlyLeaveMinutes = 0;
  if (work.length > 0 && closed.length > 0) {
    const lastEnd = Math.max(
      ...work.map((s) => shiftWindow(date, s.startTime, s.endTime, tz).end.getTime()),
    );
    const lastOut = Math.max(...closed.map((s) => s.outAt!.getTime()));
    const diff = Math.floor((lastEnd - lastOut) / 60_000) - rules.earlyLeaveToleranceMinutes;
    earlyLeaveMinutes = diff > 0 ? diff : 0;
    if (earlyLeaveMinutes > 0) {
      incidents.push({ code: IncidentCode.EARLY_LEAVE, message: `Salida anticipada de ${earlyLeaveMinutes} min` });
    }
  }

  // --- Sobretiempo -----------------------------------------------------------
  const hasShift = work.length > 0;
  const limit = hasShift ? scheduledMinutes : rules.dailyOrdinaryMinutes;
  const overtime = splitOvertime(workedMinutes, limit, {
    thresholdMinutes: rules.overtimeThresholdMinutes,
    tier1Minutes: rules.overtimeTier1Minutes,
  });
  if (!hasShift && workedMinutes > 0) {
    incidents.push({
      code: IncidentCode.UNSCHEDULED_WORK,
      message: "Trabajo en un dia sin turno asignado (revisa si era descanso o feriado)",
    });
  }
  if (overtime.overtimeMinutes > (input.approvedOvertimeMinutes ?? 0)) {
    incidents.push({
      code: IncidentCode.OVERTIME_NOT_AUTHORIZED,
      message:
        input.approvedOvertimeMinutes === null
          ? "Sobretiempo sin solicitud aprobada (se calcula igual: el trabajo prestado se paga)"
          : `Sobretiempo superior a lo aprobado (${input.approvedOvertimeMinutes} min)`,
    });
  }

  const hasPunches = input.sessions.length > 0;
  const isJustified = input.hasApprovedAbsence && !hasPunches;
  const isAbsent = hasShift && !hasPunches && !input.hasApprovedAbsence && date < input.today;
  if (isAbsent) incidents.push({ code: IncidentCode.ABSENT, message: "Falta: turno asignado sin marcaciones" });

  return {
    date,
    scheduledMinutes,
    workedMinutes,
    lunchMinutes,
    ordinaryMinutes: workedMinutes - overtime.overtimeMinutes,
    overtimeMinutes: overtime.overtimeMinutes,
    overtimeTier1Minutes: overtime.tier1Minutes,
    overtimeTier2Minutes: overtime.tier2Minutes,
    overtimeAuthorizedMinutes: input.approvedOvertimeMinutes,
    nightMinutes: night,
    isNightShift: workedMinutes > 0 && night * 100 >= workedMinutes * rules.nightShiftMinSharePct,
    crossesMidnight,
    tardinessMinutes: tardiness,
    earlyLeaveMinutes,
    hasShift,
    hasPunches,
    isComplete: closed.length > 0,
    isAbsent,
    isJustified,
    isLate: tardiness > 0,
    incidents,
    sessions,
    justifications: input.justifications ?? [],
  };
}

/** Lunes (`YYYY-MM-DD`) de la semana que contiene `date`. Semana laboral lun-dom. */
export function weekStartMonday(date: string): string {
  const weekday = new Date(`${date}T12:00:00.000Z`).getUTCDay();
  return addDays(date, -((weekday + 6) % 7));
}

/**
 * Exceso semanal: minutos ordinarios de la semana por encima de la jornada
 * semanal. El sobretiempo diario ya esta descontado de los ordinarios, asi que
 * no se cuenta dos veces.
 */
export function weeklyExcess(
  jornadas: readonly Pick<JornadaMetrics, "date" | "ordinaryMinutes">[],
  weeklyOrdinaryMinutes: number,
): { weekStart: string; ordinaryMinutes: number; excessMinutes: number }[] {
  const byWeek = new Map<string, number>();
  for (const j of jornadas) {
    const key = weekStartMonday(j.date);
    byWeek.set(key, (byWeek.get(key) ?? 0) + j.ordinaryMinutes);
  }
  return [...byWeek.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([weekStart, ordinaryMinutes]) => ({
      weekStart,
      ordinaryMinutes,
      excessMinutes: Math.max(0, ordinaryMinutes - weeklyOrdinaryMinutes),
    }));
}

export interface PayReference {
  currency: string;
  /** RMV configurada, o null. */
  minimumWage: number | null;
  /** Valor hora de la RMV (RMV / divisor). */
  minimumWageHourly: number | null;
  /** Piso mensual del trabajador nocturno: RMV x (1 + sobretasa). */
  nightMinimumMonthly: number | null;
  /** Sobretasa nocturna por hora calculada sobre el valor hora de la RMV. */
  nightSurchargePerHour: number | null;
  /** Factores multiplicadores del valor hora para cada tramo de sobretiempo. */
  overtimeTier1Factor: number;
  overtimeTier2Factor: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Referencias monetarias transparentes. No hay salario por empleado en el
 * sistema (dato sensible que vive en la planilla): se entregan factores y la
 * referencia sobre la RMV para que el calculo sea reproducible a mano.
 */
export function payReference(rules: LaborRules): PayReference {
  const rmv = rules.minimumWage;
  const hourly = rmv !== null && rules.hourlyDivisor > 0 ? rmv / rules.hourlyDivisor : null;
  return {
    currency: rules.payrollCurrency,
    minimumWage: rmv,
    minimumWageHourly: hourly === null ? null : round2(hourly),
    nightMinimumMonthly: rmv === null ? null : round2(rmv * (1 + rules.nightSurchargePct / 100)),
    nightSurchargePerHour: hourly === null ? null : round2((hourly * rules.nightSurchargePct) / 100),
    overtimeTier1Factor: 1 + rules.overtimeTier1RatePct / 100,
    overtimeTier2Factor: 1 + rules.overtimeTier2RatePct / 100,
  };
}
