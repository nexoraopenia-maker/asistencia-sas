/**
 * Motor de jornadas: fecha operativa, sesiones de trabajo, horario nocturno y
 * desglose de sobretiempo.
 *
 * El problema que resuelve: agrupar marcaciones por DIA DE CALENDARIO corta a
 * las 00:00 cualquier jornada nocturna. Una entrada a las 20:00 y su salida a
 * las 02:00 caen en fechas distintas; la salida queda huerfana, el validador de
 * secuencia la rechaza ("primero marca tu entrada") y la nomina pierde las
 * horas. Aqui la unidad no es el dia sino la SESION (entrada -> salida), y la
 * sesion pertenece a la FECHA OPERATIVA en que empezo (o a la del turno que
 * la ampara, si el empleado llego despues de medianoche a un turno de la
 * noche anterior).
 *
 * Todo es puro y sin E/S: lo comparten la API (validacion en vivo, reloj
 * biometrico, reportes) y la app movil, de modo que todos los caminos deciden
 * igual.
 */

import { PunchType, ShiftType, VALID_PUNCH_TRANSITIONS } from "./enums.js";
import { timeToSeconds, toZonedDateString, zonedLocalToUtc } from "./time.js";

const MINUTE = 60_000;

// =============================================================================
// Fechas y ventanas de turno
// =============================================================================

/** Suma `days` dias a una fecha `YYYY-MM-DD`. */
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export interface ShiftSlot {
  id?: string;
  /** Fecha operativa del turno (`Shift.date`), `YYYY-MM-DD`. */
  date: string;
  type: ShiftType | string;
  startTime: string;
  endTime: string;
}

export interface Interval {
  start: Date;
  end: Date;
}

/**
 * Instantes de inicio y fin de un tramo. Si `endTime` es menor que
 * `startTime`, el tramo termina al dia siguiente (22:00 -> 06:00).
 */
export function shiftWindow(
  date: string,
  startTime: string,
  endTime: string,
  timeZone: string,
): Interval {
  const endDate = timeToSeconds(endTime) < timeToSeconds(startTime) ? addDays(date, 1) : date;
  return {
    start: zonedLocalToUtc(date, startTime, timeZone),
    end: zonedLocalToUtc(endDate, endTime, timeZone),
  };
}

/**
 * Ventana del refrigerio dentro de una jornada. En un turno 20:00 -> 04:00 con
 * refrigerio 00:30 -> 01:00, el refrigerio es de la madrugada SIGUIENTE aunque
 * el turno este guardado con la fecha del inicio.
 */
export function lunchWindow(
  date: string,
  lunch: Pick<ShiftSlot, "startTime" | "endTime">,
  work: Pick<ShiftSlot, "startTime" | "endTime"> | null,
  timeZone: string,
): Interval {
  const startsNextDay = work !== null && timeToSeconds(lunch.startTime) < timeToSeconds(work.startTime);
  return shiftWindow(startsNextDay ? addDays(date, 1) : date, lunch.startTime, lunch.endTime, timeZone);
}

/**
 * Margen antes del inicio de un turno en el que una entrada ya se atribuye a
 * el. Cubre al que llega temprano sin capturar la jornada de otro dia.
 */
export const SHIFT_EARLY_ARRIVAL_MINUTES = 240;

export interface OperationalDateResult {
  /** Fecha operativa a la que pertenece la jornada. */
  date: string;
  /** Turno de trabajo que la ampara, si hay alguno. */
  shift: ShiftSlot | null;
  /** Ventana del turno elegido. */
  window: Interval | null;
}

/**
 * Fecha operativa de una ENTRADA.
 *
 * 1. Si cae dentro de la ventana de un turno de trabajo (contando el margen de
 *    llegada temprana), la fecha es la de ese turno. Asi, quien llega a las
 *    00:10 a un turno de 23:00 del dia anterior queda en la jornada correcta
 *    y con 70 minutos de tardanza, no como "dia nuevo sin turno".
 * 2. Si no, el turno de trabajo del dia local con el inicio mas cercano.
 * 3. Sin turnos, el dia local de la marcacion.
 *
 * `workShifts` debe traer los turnos WORK del dia local y del anterior.
 */
export function resolveOperationalDate(
  instant: Date,
  timeZone: string,
  workShifts: readonly ShiftSlot[],
): OperationalDateResult {
  const localDate = toZonedDateString(instant, timeZone);
  const t = instant.getTime();
  const candidates = workShifts
    .filter((s) => s.type === ShiftType.WORK && (s.date === localDate || s.date === addDays(localDate, -1)))
    .map((shift) => ({ shift, window: shiftWindow(shift.date, shift.startTime, shift.endTime, timeZone) }));

  const containing = candidates
    .filter(
      ({ window }) =>
        t >= window.start.getTime() - SHIFT_EARLY_ARRIVAL_MINUTES * MINUTE && t < window.end.getTime(),
    )
    .sort((a, b) => Math.abs(t - a.window.start.getTime()) - Math.abs(t - b.window.start.getTime()));
  if (containing[0]) return { date: containing[0].shift.date, ...containing[0] };

  const sameDay = candidates
    .filter(({ shift }) => shift.date === localDate)
    .sort((a, b) => Math.abs(t - a.window.start.getTime()) - Math.abs(t - b.window.start.getTime()));
  if (sameDay[0]) return { date: localDate, ...sameDay[0] };

  return { date: localDate, shift: null, window: null };
}

/** Tardanza en minutos respecto al inicio real del turno (instantes, no horas). */
export function lateMinutesFrom(instant: Date, scheduledStart: Date, toleranceMinutes = 0): number {
  const late = Math.floor((instant.getTime() - scheduledStart.getTime()) / MINUTE) - toleranceMinutes;
  return late > 0 ? late : 0;
}

// =============================================================================
// Sesiones
// =============================================================================

export interface PunchLike {
  id?: string;
  punchType: PunchType | string;
  at: Date;
}

export type SessionStatus =
  /** Entrada y salida registradas. */
  | "CLOSED"
  /** Entrada sin salida, aun dentro del plazo `maxShiftHours`: el empleado esta dentro. */
  | "OPEN"
  /** Entrada sin salida y plazo vencido: incidencia para RRHH. */
  | "MISSING_OUT"
  /** Salida o refrigerio sin entrada previa en plazo: incidencia para RRHH. */
  | "ORPHAN";

export interface WorkSession<P extends PunchLike = PunchLike> {
  operationalDate: string;
  status: SessionStatus;
  punches: P[];
  inAt: Date | null;
  outAt: Date | null;
  /** Refrigerios; `end` null si el refrigerio sigue abierto. */
  breaks: { start: Date; end: Date | null }[];
}

export interface BuildSessionsOptions {
  /** Plazo maximo entre la entrada y la salida. */
  maxShiftHours: number;
  /** Ahora: decide si una sesion sin salida sigue abierta o ya es incidencia. */
  now: Date;
  /** Fecha operativa de la entrada que abre cada sesion. */
  operationalDateFor: (inAt: Date) => string;
  /** Fecha para marcaciones huerfanas (por defecto, la misma funcion). */
  orphanDateFor?: (at: Date) => string;
}

/**
 * Agrupa marcaciones (de UN empleado) en sesiones IN -> ... -> OUT.
 *
 * No depende de la fecha de calendario: una sesion se cierra con su OUT o al
 * vencer `maxShiftHours`, nunca a medianoche.
 */
export function buildSessions<P extends PunchLike>(
  punches: readonly P[],
  options: BuildSessionsOptions,
): WorkSession<P>[] {
  const maxMs = options.maxShiftHours * 3_600_000;
  const orphanDate = options.orphanDateFor ?? options.operationalDateFor;
  const ordered = [...punches].sort((a, b) => a.at.getTime() - b.at.getTime());
  const sessions: WorkSession<P>[] = [];
  let current: WorkSession<P> | null = null;

  const expire = (session: WorkSession<P>, reference: Date) => {
    if (session.status === "OPEN" && reference.getTime() - session.inAt!.getTime() > maxMs) {
      session.status = "MISSING_OUT";
    }
  };

  for (const punch of ordered) {
    if (current) expire(current, punch.at);
    if (current && current.status !== "OPEN") current = null;

    if (punch.punchType === PunchType.IN) {
      // Dos entradas seguidas: la anterior se queda sin salida.
      if (current) current.status = "MISSING_OUT";
      current = {
        operationalDate: options.operationalDateFor(punch.at),
        status: "OPEN",
        punches: [punch],
        inAt: punch.at,
        outAt: null,
        breaks: [],
      };
      sessions.push(current);
      continue;
    }

    if (!current) {
      sessions.push({
        operationalDate: orphanDate(punch.at),
        status: "ORPHAN",
        punches: [punch],
        inAt: null,
        outAt: null,
        breaks: [],
      });
      continue;
    }

    current.punches.push(punch);
    if (punch.punchType === PunchType.LUNCH_START) {
      current.breaks.push({ start: punch.at, end: null });
    } else if (punch.punchType === PunchType.LUNCH_END) {
      const open = [...current.breaks].reverse().find((b) => b.end === null);
      if (open) open.end = punch.at;
      else current.breaks.push({ start: punch.at, end: punch.at });
    } else if (punch.punchType === PunchType.OUT) {
      current.outAt = punch.at;
      current.status = "CLOSED";
      current = null;
    }
  }

  if (current) expire(current, options.now);
  return sessions;
}

/** Intervalos efectivamente trabajados: [entrada, salida] menos refrigerios cerrados. */
export function workedIntervals(session: WorkSession): Interval[] {
  if (session.status !== "CLOSED" || !session.inAt || !session.outAt) return [];
  const breaks = session.breaks
    .filter((b): b is { start: Date; end: Date } => b.end !== null)
    .sort((a, b) => a.start.getTime() - b.start.getTime());

  const result: Interval[] = [];
  let cursor = session.inAt;
  for (const b of breaks) {
    const start = new Date(Math.max(b.start.getTime(), cursor.getTime()));
    const end = new Date(Math.min(b.end.getTime(), session.outAt.getTime()));
    if (end <= start) continue;
    if (start > cursor) result.push({ start: cursor, end: start });
    cursor = end;
  }
  if (session.outAt > cursor) result.push({ start: cursor, end: session.outAt });
  return result;
}

export function intervalMinutes(intervals: readonly Interval[]): number {
  return Math.round(intervals.reduce((sum, i) => sum + (i.end.getTime() - i.start.getTime()), 0) / MINUTE);
}

/** Minutos de refrigerio cerrados de una sesion. */
export function breakMinutes(session: WorkSession): number {
  return Math.round(
    session.breaks.reduce(
      (sum, b) => sum + (b.end ? Math.max(0, b.end.getTime() - b.start.getTime()) : 0),
      0,
    ) / MINUTE,
  );
}

// =============================================================================
// Secuencia en vivo
// =============================================================================

export interface PunchStateInput {
  /** Sesiones del empleado hasta el instante evaluado (ver `buildSessions`). */
  sessions: readonly WorkSession[];
  /** Fecha operativa que tendria una entrada nueva en este instante. */
  newSessionDate: string;
  /** Turnos WORK asignados en `newSessionDate`. */
  workShiftsOnNewDate: number;
  allowSplitShifts: boolean;
}

export interface PunchState {
  /** Ultima marcacion de la jornada vigente, o NONE si no hay ninguna abierta. */
  previous: PunchType | "NONE";
  allowed: readonly PunchType[];
  /** Fecha operativa a la que iria la siguiente marcacion. */
  operationalDate: string;
  /** Sesion abierta, si la hay. */
  openSession: WorkSession | null;
}

/**
 * Que marcacion corresponde ahora.
 *
 * - Con una sesion abierta (dentro de `maxShiftHours`), manda la tabla de
 *   transiciones a partir de su ultima marcacion: la salida de las 02:00
 *   cierra la entrada de las 20:00 del dia anterior.
 * - Sin sesion abierta, se puede entrar salvo que la fecha operativa ya tenga
 *   su jornada cerrada y no proceda un turno partido (mas turnos asignados que
 *   sesiones cerradas, o la empresa lo permite siempre).
 */
export function resolvePunchState(input: PunchStateInput): PunchState {
  const last = input.sessions.at(-1);
  if (last && last.status === "OPEN") {
    const previous = last.punches.at(-1)!.punchType as PunchType;
    return {
      previous,
      allowed: VALID_PUNCH_TRANSITIONS[previous],
      operationalDate: last.operationalDate,
      openSession: last,
    };
  }

  const closedSameDay = input.sessions.filter(
    (s) => s.operationalDate === input.newSessionDate && s.status === "CLOSED",
  ).length;
  const canStartAnother =
    closedSameDay === 0 || input.allowSplitShifts || input.workShiftsOnNewDate > closedSameDay;

  return canStartAnother
    ? { previous: "NONE", allowed: VALID_PUNCH_TRANSITIONS.NONE, operationalDate: input.newSessionDate, openSession: null }
    : { previous: PunchType.OUT, allowed: VALID_PUNCH_TRANSITIONS.OUT, operationalDate: input.newSessionDate, openSession: null };
}

// =============================================================================
// Horario nocturno y sobretiempo
// =============================================================================

/**
 * Minutos de `intervals` que caen en el horario nocturno local
 * (`nightStart` -> `nightEnd`, por defecto 22:00 -> 06:00). Se calcula sobre
 * instantes, asi que respeta la zona horaria y el cruce de medianoche.
 */
export function nightMinutes(
  intervals: readonly Interval[],
  timeZone: string,
  nightStart = "22:00:00",
  nightEnd = "06:00:00",
): number {
  let total = 0;
  for (const interval of intervals) {
    const firstDay = addDays(toZonedDateString(interval.start, timeZone), -1);
    const lastDay = toZonedDateString(interval.end, timeZone);
    for (let day = firstDay; day <= lastDay; day = addDays(day, 1)) {
      const night = shiftWindow(day, nightStart, nightEnd, timeZone);
      const start = Math.max(night.start.getTime(), interval.start.getTime());
      const end = Math.min(night.end.getTime(), interval.end.getTime());
      if (end > start) total += end - start;
    }
  }
  return Math.round(total / MINUTE);
}

export interface OvertimeRules {
  /** Exceso por debajo de este umbral no computa. */
  thresholdMinutes: number;
  /** Duracion del primer tramo (120 = "las dos primeras horas"). */
  tier1Minutes: number;
}

export interface OvertimeSplit {
  overtimeMinutes: number;
  tier1Minutes: number;
  tier2Minutes: number;
}

/** Reparte el exceso diario entre los dos tramos de sobretiempo. */
export function splitOvertime(
  workedMinutes: number,
  ordinaryLimitMinutes: number,
  rules: OvertimeRules,
): OvertimeSplit {
  const excess = Math.max(0, workedMinutes - ordinaryLimitMinutes);
  const overtime = excess >= Math.max(1, rules.thresholdMinutes) ? excess : 0;
  const tier1 = Math.min(overtime, rules.tier1Minutes);
  return { overtimeMinutes: overtime, tier1Minutes: tier1, tier2Minutes: overtime - tier1 };
}
