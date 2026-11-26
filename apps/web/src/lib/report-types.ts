import type { JornadaMetrics, LaborRules, PayReference } from "@scire/shared";

/** Respuesta de `GET /api/v1/reports/detail`. */
export interface AttendanceDetail {
  range: { from: string; to: string };
  rules: LaborRules;
  payReference: PayReference;
  employees: {
    userId: string;
    fullName: string;
    employeeCode: string;
    branchName: string | null;
    timezone: string;
    days: JornadaMetrics[];
  }[];
}

/** Fila de `GET /api/v1/reports/payroll`. */
export interface PayrollRow {
  userId: string;
  fullName: string;
  employeeCode: string;
  jobTitle: string | null;
  branchName: string | null;
  daysWorked: number;
  daysAbsent: number;
  regularMinutes: number;
  lunchMinutes: number;
  tardinessMinutes: number;
  earlyLeaveMinutes: number;
  overtimeMinutes: number;
  scheduledMinutes: number;
  ordinaryMinutes: number;
  overtimeTier1Minutes: number;
  overtimeTier2Minutes: number;
  nightMinutes: number;
  nightShifts: number;
  weeklyExcessMinutes: number;
  incidentCount: number;
}

/** `510` -> `8:30`. */
export function hhmm(minutes: number): string {
  const abs = Math.abs(Math.round(minutes));
  return `${Math.floor(abs / 60)}:${String(abs % 60).padStart(2, "0")}`;
}
