import { db } from "@scire/database";
import {
  ABSENCE_LABELS,
  addDays,
  buildSessions,
  computeJornada,
  IncidentCode,
  payReference,
  resolveOperationalDate,
  ShiftType,
  tardinessMinutes,
  toZonedDateString,
  UserStatus,
  weeklyExcess,
  zonedLocalToUtc,
  type JornadaMetrics,
  type JornadaPunch,
  type LaborRules,
  type PayReference,
  type WorkSession,
} from "@scire/shared";
import { loadLaborRules, type ShiftSlotRow } from "../../services/workday.service.js";

/**
 * Agregacion de asistencia para KPIs y nomina.
 *
 * La unidad es la JORNADA (fecha operativa), no el dia de calendario: un turno
 * de 20:00 a 04:00 cuenta entero en la fecha en que empezo. Las reglas de
 * calculo viven en `@scire/shared` (`labor.ts`).
 *
 * Todo el calculo se hace en memoria a partir de consultas por rango en vez de
 * una consulta por empleado y dia: se evita el patron N+1 que haria inusable el
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
  /** Trabajado dentro de la jornada ordinaria (trabajado - sobretiempo). */
  ordinaryMinutes: number;
  /** Sobretiempo del primer tramo (25 % por defecto). */
  overtimeTier1Minutes: number;
  /** Sobretiempo desde el segundo tramo (35 % por defecto). */
  overtimeTier2Minutes: number;
  /** Trabajado en horario nocturno (22:00-06:00 por defecto). */
  nightMinutes: number;
  /** Jornadas calificadas como nocturnas. */
  nightShifts: number;
  /** Exceso sobre la jornada semanal no cubierto por el sobretiempo diario. */
  weeklyExcessMinutes: number;
  incidentCount: number;
}

export interface AttendanceDetailEmployee {
  userId: string;
  fullName: string;
  employeeCode: string;
  branchName: string | null;
  timezone: string;
  days: JornadaMetrics[];
  weeks: { weekStart: string; ordinaryMinutes: number; excessMinutes: number }[];
}

export interface AttendanceDetail {
  range: { from: string; to: string };
  /** Parametros aplicados: el informe debe poder reproducirse a mano. */
  rules: LaborRules;
  payReference: PayReference;
  employees: AttendanceDetailEmployee[];
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

/** Carga el rango y calcula las jornadas de cada empleado. */
async function loadRange(filters: ReportFilters) {
  const rules = await loadLaborRules();
  const now = new Date();

  const from = new Date(`${filters.from}T00:00:00.000Z`);
  const to = new Date(`${filters.to}T00:00:00.000Z`);
  // Se leen dias de mas a ambos lados: la salida del turno noche del ultimo dia
  // cae fuera del rango, y la entrada que abre una jornada puede ser anterior.
  const margin = Math.ceil(rules.maxShiftHours / 24) + 1;
  const punchFrom = zonedLocalToUtc(addDays(filters.from, -margin - 1), "00:00:00", rules.timezone);
  const punchTo = zonedLocalToUtc(addDays(filters.to, margin + 2), "00:00:00", rules.timezone);

  const users = await db.user.findMany({
    where: {
      // INVITED entra solo si ficho (p. ej. quien solo usa el reloj biometrico).
      status: { in: [UserStatus.ACTIVE, UserStatus.SUSPENDED, UserStatus.INVITED] },
      ...(filters.branchId ? { branchId: filters.branchId } : {}),
      ...(filters.userId ? { id: filters.userId } : {}),
    },
    select: {
      id: true,
      status: true,
      fullName: true,
      employeeCode: true,
      jobTitle: true,
      branch: { select: { name: true, timezone: true } },
    },
    orderBy: { fullName: "asc" },
  });
  const userIds = users.map((u) => u.id);

  const [shiftRows, punchRows, absences] = await Promise.all([
    db.shift.findMany({
      where: {
        userId: { in: userIds },
        date: {
          gte: new Date(punchFrom.toISOString().slice(0, 10)),
          lte: new Date(punchTo.toISOString().slice(0, 10)),
        },
      },
      select: { id: true, userId: true, date: true, type: true, startTime: true, endTime: true },
      orderBy: [{ date: "asc" }, { startTime: "asc" }],
    }),
    db.attendanceRecord.findMany({
      where: {
        userId: { in: userIds },
        isVoided: false,
        serverTimestamp: { gte: punchFrom, lt: punchTo },
      },
      select: {
        id: true,
        userId: true,
        punchType: true,
        source: true,
        serverTimestamp: true,
        tardinessMinutes: true,
        isMockLocation: true,
        isWithinGeofence: true,
        verificationStatus: true,
        notes: true,
      },
      orderBy: { serverTimestamp: "asc" },
    }),
    db.absence.findMany({
      where: {
        userId: { in: userIds },
        status: "APPROVED",
        startDate: { lte: to },
        endDate: { gte: from },
      },
      select: {
        userId: true,
        type: true,
        startDate: true,
        endDate: true,
        approvedMinutes: true,
        reason: true,
      },
    }),
  ]);

  const group = <T extends { userId: string }>(rows: T[]) => {
    const map = new Map<string, T[]>();
    for (const row of rows) (map.get(row.userId) ?? map.set(row.userId, []).get(row.userId)!).push(row);
    return map;
  };
  const shiftsByUser = group(shiftRows);
  const punchesByUser = group(punchRows);
  const absencesByUser = group(absences);

  const dates: string[] = [];
  for (let day = filters.from; day <= filters.to; day = addDays(day, 1)) dates.push(day);

  const employees = users.map((user) => {
    const timezone = user.branch?.timezone ?? rules.timezone;
    const userRules: LaborRules = { ...rules, timezone };
    const shifts: ShiftSlotRow[] = (shiftsByUser.get(user.id) ?? []).map((s) => ({
      ...s,
      date: s.date.toISOString().slice(0, 10),
    }));
    const workShifts = shifts.filter((s) => s.type === ShiftType.WORK);
    const punches: JornadaPunch[] = (punchesByUser.get(user.id) ?? []).map((p) => ({
      ...p,
      at: p.serverTimestamp,
    }));
    const sessions = buildSessions(punches, {
      maxShiftHours: rules.maxShiftHours,
      now,
      operationalDateFor: (at) => resolveOperationalDate(at, timezone, workShifts).date,
    });
    const sessionsByDate = new Map<string, WorkSession<JornadaPunch>[]>();
    for (const session of sessions) {
      const key = session.operationalDate;
      (sessionsByDate.get(key) ?? sessionsByDate.set(key, []).get(key)!).push(session);
    }

    const today = toZonedDateString(now, timezone);
    const userAbsences = absencesByUser.get(user.id) ?? [];
    const days: JornadaMetrics[] = [];

    for (const date of dates) {
      const dayShifts = shifts.filter((s) => s.date === date);
      const daySessions = sessionsByDate.get(date) ?? [];
      if (dayShifts.length === 0 && daySessions.length === 0) continue;

      const covering = userAbsences.filter(
        (a) =>
          a.startDate.toISOString().slice(0, 10) <= date &&
          a.endDate.toISOString().slice(0, 10) >= date,
      );
      const overtimeRequests = covering.filter((a) => a.type === "OVERTIME_REQUEST");

      days.push(
        computeJornada({
          date,
          sessions: daySessions,
          shifts: dayShifts,
          rules: userRules,
          approvedOvertimeMinutes: overtimeRequests.length
            ? overtimeRequests.reduce((sum, a) => sum + (a.approvedMinutes ?? 0), 0)
            : null,
          // Una tardanza justificada no convierte una falta en justificada.
          hasApprovedAbsence: covering.some(
            (a) => ![
              "OVERTIME_REQUEST",
              "JUSTIFIED_TARDINESS",
              "UNJUSTIFIED_ABSENCE",
            ].includes(a.type),
          ),
          justifications: covering.map((a) => `${ABSENCE_LABELS[a.type]}: ${a.reason}`),
          tardinessJustified: covering.some((a) => a.type === "JUSTIFIED_TARDINESS"),
          today,
        }),
      );
    }

    const weeks = weeklyExcess(days, rules.weeklyOrdinaryMinutes);
    for (const week of weeks) {
      if (week.excessMinutes === 0) continue;
      const lastDay = days.filter((d) => d.date >= week.weekStart && d.date < addDays(week.weekStart, 7)).at(-1);
      lastDay?.incidents.push({
        code: IncidentCode.WEEKLY_EXCESS,
        message: `Exceso de ${week.excessMinutes} min sobre la jornada semanal (semana del ${week.weekStart})`,
      });
    }

    return { user, timezone, days, weeks, punches };
  });

  const visible = employees.filter((e) => e.user.status !== UserStatus.INVITED || e.punches.length > 0);

  return { rules, employees: visible, dates };
}

const sum = <T>(rows: readonly T[], pick: (row: T) => number) =>
  rows.reduce((total, row) => total + pick(row), 0);

export async function getPayroll(filters: ReportFilters): Promise<PayrollRow[]> {
  const { employees } = await loadRange(filters);

  return employees.map(({ user, days, weeks }) => ({
    userId: user.id,
    fullName: user.fullName,
    employeeCode: user.employeeCode,
    jobTitle: user.jobTitle,
    branchName: user.branch?.name ?? null,
    daysWorked: days.filter((d) => d.isComplete).length,
    daysAbsent: days.filter((d) => d.isAbsent).length,
    regularMinutes: sum(days, (d) => d.workedMinutes),
    lunchMinutes: sum(days, (d) => d.lunchMinutes),
    tardinessMinutes: sum(days, (d) => d.tardinessMinutes),
    earlyLeaveMinutes: sum(days, (d) => d.earlyLeaveMinutes),
    overtimeMinutes: sum(days, (d) => d.overtimeMinutes),
    scheduledMinutes: sum(days, (d) => d.scheduledMinutes),
    ordinaryMinutes: sum(days, (d) => d.ordinaryMinutes),
    overtimeTier1Minutes: sum(days, (d) => d.overtimeTier1Minutes),
    overtimeTier2Minutes: sum(days, (d) => d.overtimeTier2Minutes),
    nightMinutes: sum(days, (d) => d.nightMinutes),
    nightShifts: days.filter((d) => d.isNightShift).length,
    weeklyExcessMinutes: sum(weeks, (w) => w.excessMinutes),
    incidentCount: sum(days, (d) => d.incidents.length),
  }));
}

/** Desglose jornada por jornada, con incidencias, para auditoria y planillas. */
export async function getDetail(filters: ReportFilters): Promise<AttendanceDetail> {
  const { rules, employees } = await loadRange(filters);
  return {
    range: { from: filters.from, to: filters.to },
    rules,
    payReference: payReference(rules),
    employees: employees.map(({ user, timezone, days, weeks }) => ({
      userId: user.id,
      fullName: user.fullName,
      employeeCode: user.employeeCode,
      branchName: user.branch?.name ?? null,
      timezone,
      days,
      weeks,
    })),
  };
}

export async function getSummary(filters: ReportFilters): Promise<AttendanceSummary> {
  const { employees, dates } = await loadRange(filters);

  const daily = new Map<string, DailyPoint>(
    dates.map((date) => [date, { date, present: 0, late: 0, absent: 0, workedMinutes: 0 }]),
  );
  let scheduledDays = 0;
  let punctualDays = 0;
  let absentDays = 0;

  for (const day of employees.flatMap((e) => e.days)) {
    const point = daily.get(day.date)!;
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

  const days = employees.flatMap((e) => e.days);
  const inRange = new Set(dates);
  const alertCount = employees
    .flatMap((e) => e.punches.map((p) => ({ ...p, timezone: e.timezone })))
    .filter(
      (p) =>
        (p.isMockLocation || p.isWithinGeofence === false) &&
        inRange.has(toZonedDateString(p.at, p.timezone)),
    ).length;
  const pct = (value: number, total: number) => (total > 0 ? Math.round((value / total) * 1000) / 10 : 0);

  return {
    range: { from: filters.from, to: filters.to },
    totalEmployees: employees.length,
    punctualityRate: pct(punctualDays, scheduledDays),
    absenteeismRate: pct(absentDays, scheduledDays),
    overtimeMinutes: sum(days, (d) => d.overtimeMinutes),
    tardinessMinutes: sum(days, (d) => d.tardinessMinutes),
    workedMinutes: sum(days, (d) => d.workedMinutes),
    scheduledMinutes: sum(days, (d) => d.scheduledMinutes),
    alertCount,
    daily: [...daily.values()],
  };
}

/** Recalcula la tardanza de una marcacion concreta. Util en los tests. */
export function tardinessFor(shiftStart: string, actual: string, tolerance: number): number {
  return tardinessMinutes(shiftStart, actual, tolerance);
}
