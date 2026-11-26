import { db } from "@scire/database";
import {
  PunchType,
  ShiftType,
  UserStatus,
  durationSeconds,
  tardinessMinutes,
  timeToSeconds,
  toZonedDateString,
  toZonedTimeString,
} from "@scire/shared";

/**
 * Agregacion de asistencia para KPIs y nomina.
 *
 * Todo el calculo se hace en memoria a partir de DOS consultas (turnos y
 * marcaciones del rango) en vez de una consulta por empleado y dia. Para una
 * empresa de 150 personas y un mes completo son ~6 000 turnos y ~13 000
 * marcaciones: trivial para Node, y evita el patron N+1 que haria inusable el
 * informe justo cuando la empresa crece.
 */

export interface ReportFilters {
  from: string;
  to: string;
  branchId?: string;
  userId?: string;
}

export interface PayrollRow {
  userId: string;
  fullName: string;
  employeeCode: string;
  jobTitle: string | null;
  branchName: string | null;
  /** Dias con jornada cerrada (entrada y salida). */
  daysWorked: number;
  /** Dias con turno asignado y sin ninguna marcacion. */
  daysAbsent: number;
  /** Minutos efectivamente trabajados, descontado el refrigerio. */
  regularMinutes: number;
  lunchMinutes: number;
  tardinessMinutes: number;
  /** Minutos de salida anticipada, descontada la tolerancia de la empresa. */
  earlyLeaveMinutes: number;
  overtimeMinutes: number;
  /** Minutos programados segun turno, ya sin el refrigerio. */
  scheduledMinutes: number;
}

export interface DailyPoint {
  date: string;
  present: number;
  late: number;
  absent: number;
  workedMinutes: number;
}

export interface AttendanceSummary {
  range: { from: string; to: string };
  totalEmployees: number;
  /** Porcentaje de jornadas iniciadas a tiempo sobre las jornadas con turno. */
  punctualityRate: number;
  /** Porcentaje de jornadas con turno en las que nadie marco. */
  absenteeismRate: number;
  overtimeMinutes: number;
  tardinessMinutes: number;
  workedMinutes: number;
  scheduledMinutes: number;
  /** Marcaciones con GPS simulado o fuera de geocerca en el rango. */
  alertCount: number;
  daily: DailyPoint[];
}

type ShiftRow = {
  userId: string;
  date: Date;
  type: string;
  startTime: string;
  endTime: string;
};

type PunchRow = {
  userId: string;
  punchType: string;
  serverTimestamp: Date;
  tardinessMinutes: number;
  isMockLocation: boolean;
  isWithinGeofence: boolean | null;
};

const dayKey = (userId: string, date: string) => `${userId}|${date}`;

/** Metricas de un empleado en un dia concreto. */
interface DayMetrics {
  scheduledMinutes: number;
  workedMinutes: number;
  lunchMinutes: number;
  tardinessMinutes: number;
  earlyLeaveMinutes: number;
  overtimeMinutes: number;
  hasShift: boolean;
  hasPunches: boolean;
  isComplete: boolean;
  isLate: boolean;
}

function computeDay(
  shifts: ShiftRow[],
  punches: PunchRow[],
  timezone: string,
  earlyLeaveTolerance: number,
): DayMetrics {
  const work = shifts.find((s) => s.type === ShiftType.WORK);
  const lunch = shifts.find((s) => s.type === ShiftType.LUNCH);

  const scheduledMinutes = work
    ? Math.round(
        (durationSeconds(work.startTime, work.endTime) -
          (lunch ? durationSeconds(lunch.startTime, lunch.endTime) : 0)) /
          60,
      )
    : 0;

  const at = (type: string) => punches.find((p) => p.punchType === type)?.serverTimestamp;
  const inAt = at(PunchType.IN);
  const outAt = at(PunchType.OUT);
  const lunchStart = at(PunchType.LUNCH_START);
  const lunchEnd = at(PunchType.LUNCH_END);

  const lunchMinutes =
    lunchStart && lunchEnd
      ? Math.max(0, Math.round((lunchEnd.getTime() - lunchStart.getTime()) / 60_000))
      : 0;

  // Sin salida no se cuentan horas: inventar una hora de cierre seria fabricar
  // datos de nomina. El dia figura como presente pero con 0 minutos.
  const isComplete = Boolean(inAt && outAt);
  const workedMinutes = isComplete
    ? Math.max(0, Math.round((outAt!.getTime() - inAt!.getTime()) / 60_000) - lunchMinutes)
    : 0;

  const tardiness = punches.reduce((sum, p) => sum + p.tardinessMinutes, 0);

  // Salida anticipada: minutos entre la salida real y el fin de turno, menos
  // la tolerancia. Solo aplica si la jornada se cerro.
  let earlyLeaveMinutes = 0;
  if (work && outAt && isComplete) {
    const scheduledEnd = timeToSeconds(work.endTime);
    const actualEnd = timeToSeconds(toZonedTimeString(outAt, timezone));
    const diffMinutes = Math.floor((scheduledEnd - actualEnd) / 60) - earlyLeaveTolerance;
    earlyLeaveMinutes = diffMinutes > 0 ? diffMinutes : 0;
  }

  return {
    scheduledMinutes,
    workedMinutes,
    lunchMinutes,
    tardinessMinutes: tardiness,
    earlyLeaveMinutes,
    overtimeMinutes:
      isComplete && scheduledMinutes > 0 ? Math.max(0, workedMinutes - scheduledMinutes) : 0,
    hasShift: Boolean(work),
    hasPunches: punches.length > 0,
    isComplete,
    isLate: tardiness > 0,
  };
}

/** Carga turnos y marcaciones del rango y los agrupa por empleado y dia. */
async function loadRange(filters: ReportFilters) {
  const company = await db.company.findFirstOrThrow({
    select: { timezone: true, earlyLeaveToleranceMinutes: true },
  });

  const from = new Date(`${filters.from}T00:00:00.000Z`);
  const to = new Date(`${filters.to}T00:00:00.000Z`);
  // Ventana ampliada un dia a cada lado: el offset de la zona horaria puede
  // desplazar una marcacion al dia UTC contiguo.
  const punchFrom = new Date(from.getTime() - 86_400_000);
  const punchTo = new Date(to.getTime() + 2 * 86_400_000);

  const userWhere = {
    status: { in: [UserStatus.ACTIVE, UserStatus.SUSPENDED] },
    ...(filters.branchId ? { branchId: filters.branchId } : {}),
    ...(filters.userId ? { id: filters.userId } : {}),
  };

  const [users, shifts, punches] = await Promise.all([
    db.user.findMany({
      where: userWhere,
      select: {
        id: true,
        fullName: true,
        employeeCode: true,
        jobTitle: true,
        branch: { select: { name: true } },
      },
      orderBy: { fullName: "asc" },
    }),
    db.shift.findMany({
      where: {
        date: { gte: from, lte: to },
        ...(filters.userId ? { userId: filters.userId } : {}),
        ...(filters.branchId ? { user: { branchId: filters.branchId } } : {}),
      },
      select: { userId: true, date: true, type: true, startTime: true, endTime: true },
    }),
    db.attendanceRecord.findMany({
      where: {
        isVoided: false,
        serverTimestamp: { gte: punchFrom, lte: punchTo },
        ...(filters.userId ? { userId: filters.userId } : {}),
        ...(filters.branchId ? { branchId: filters.branchId } : {}),
      },
      select: {
        userId: true,
        punchType: true,
        serverTimestamp: true,
        tardinessMinutes: true,
        isMockLocation: true,
        isWithinGeofence: true,
      },
      orderBy: { serverTimestamp: "asc" },
    }),
  ]);

  const shiftsByDay = new Map<string, ShiftRow[]>();
  for (const shift of shifts) {
    const key = dayKey(shift.userId, shift.date.toISOString().slice(0, 10));
    const bucket = shiftsByDay.get(key);
    if (bucket) bucket.push(shift);
    else shiftsByDay.set(key, [shift]);
  }

  const punchesByDay = new Map<string, PunchRow[]>();
  for (const punch of punches) {
    const key = dayKey(punch.userId, toZonedDateString(punch.serverTimestamp, company.timezone));
    const bucket = punchesByDay.get(key);
    if (bucket) bucket.push(punch);
    else punchesByDay.set(key, [punch]);
  }

  const dates: string[] = [];
  for (let cursor = new Date(from); cursor <= to; cursor = new Date(cursor.getTime() + 86_400_000)) {
    dates.push(cursor.toISOString().slice(0, 10));
  }

  return { company, users, shiftsByDay, punchesByDay, punches, dates };
}

export async function getPayroll(filters: ReportFilters): Promise<PayrollRow[]> {
  const { company, users, shiftsByDay, punchesByDay, dates } = await loadRange(filters);

  return users.map((user) => {
    const row: PayrollRow = {
      userId: user.id,
      fullName: user.fullName,
      employeeCode: user.employeeCode,
      jobTitle: user.jobTitle,
      branchName: user.branch?.name ?? null,
      daysWorked: 0,
      daysAbsent: 0,
      regularMinutes: 0,
      lunchMinutes: 0,
      tardinessMinutes: 0,
      earlyLeaveMinutes: 0,
      overtimeMinutes: 0,
      scheduledMinutes: 0,
    };

    for (const date of dates) {
      const key = dayKey(user.id, date);
      const shifts = shiftsByDay.get(key) ?? [];
      const punches = punchesByDay.get(key) ?? [];
      if (shifts.length === 0 && punches.length === 0) continue;

      const day = computeDay(shifts, punches, company.timezone, company.earlyLeaveToleranceMinutes);

      row.scheduledMinutes += day.scheduledMinutes;
      row.regularMinutes += day.workedMinutes;
      row.lunchMinutes += day.lunchMinutes;
      row.tardinessMinutes += day.tardinessMinutes;
      row.earlyLeaveMinutes += day.earlyLeaveMinutes;
      row.overtimeMinutes += day.overtimeMinutes;

      if (day.isComplete) row.daysWorked++;
      else if (day.hasShift && !day.hasPunches) row.daysAbsent++;
    }

    return row;
  });
}

export async function getSummary(filters: ReportFilters): Promise<AttendanceSummary> {
  const { company, users, shiftsByDay, punchesByDay, punches, dates } = await loadRange(filters);

  const daily: DailyPoint[] = [];
  let scheduledDays = 0;
  let punctualDays = 0;
  let absentDays = 0;
  let workedMinutes = 0;
  let scheduledMinutes = 0;
  let overtimeMinutes = 0;
  let tardiness = 0;

  for (const date of dates) {
    const point: DailyPoint = { date, present: 0, late: 0, absent: 0, workedMinutes: 0 };

    for (const user of users) {
      const key = dayKey(user.id, date);
      const shifts = shiftsByDay.get(key) ?? [];
      const punchList = punchesByDay.get(key) ?? [];
      if (shifts.length === 0 && punchList.length === 0) continue;

      const day = computeDay(
        shifts,
        punchList,
        company.timezone,
        company.earlyLeaveToleranceMinutes,
      );

      workedMinutes += day.workedMinutes;
      scheduledMinutes += day.scheduledMinutes;
      overtimeMinutes += day.overtimeMinutes;
      tardiness += day.tardinessMinutes;
      point.workedMinutes += day.workedMinutes;

      // Solo cuentan los dias CON turno asignado: un domingo sin turno no es
      // ausentismo, y meterlo en el denominador hundiria la tasa sin motivo.
      if (!day.hasShift) continue;
      scheduledDays++;

      if (!day.hasPunches) {
        absentDays++;
        point.absent++;
      } else if (day.isLate) {
        point.late++;
      } else {
        punctualDays++;
        point.present++;
      }
    }

    daily.push(point);
  }

  const alertCount = punches.filter((p) => p.isMockLocation || p.isWithinGeofence === false).length;
  const pct = (value: number, total: number) => (total > 0 ? Math.round((value / total) * 1000) / 10 : 0);

  return {
    range: { from: filters.from, to: filters.to },
    totalEmployees: users.length,
    punctualityRate: pct(punctualDays, scheduledDays),
    absenteeismRate: pct(absentDays, scheduledDays),
    overtimeMinutes,
    tardinessMinutes: tardiness,
    workedMinutes,
    scheduledMinutes,
    alertCount,
    daily,
  };
}

/** Recalcula la tardanza de una marcacion concreta. Util en los tests. */
export function tardinessFor(shiftStart: string, actual: string, tolerance: number): number {
  return tardinessMinutes(shiftStart, actual, tolerance);
}
