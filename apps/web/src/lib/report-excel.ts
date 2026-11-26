import ExcelJS from "exceljs";
import { hhmm, type AttendanceDetail, type PayrollRow } from "./report-types";

/**
 * Libro de nomina: Resumen por trabajador, Detalle diario, Incidencias y
 * Parametros.
 *
 * Las duraciones van como numeros con formato `[h]:mm` (fraccion de dia), no
 * como texto: asi planillas puede sumarlas y multiplicarlas en Excel.
 */

const DURATION_FORMAT = "[h]:mm";
const HEADER_FILL = "FF312E81";

type Kind = "text" | "number" | "duration";

interface Column<T> {
  header: string;
  width: number;
  kind?: Kind;
  value: (row: T) => string | number;
  /** false = no se totaliza. */
  total?: boolean;
}

function addTable<T>(
  sheet: ExcelJS.Worksheet,
  columns: Column<T>[],
  rows: T[],
  options: { title: string; totals?: boolean },
): void {
  sheet.addRow([options.title]).font = { size: 14, bold: true };
  sheet.addRow([]);

  const header = sheet.addRow(columns.map((c) => c.header));
  header.font = { bold: true, color: { argb: "FFFFFFFF" } };
  header.eachCell((cell) => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: HEADER_FILL } };
  });

  const cellValue = (column: Column<T>, raw: string | number) =>
    column.kind === "duration" ? (raw as number) / 1440 : raw;

  for (const row of rows) {
    sheet.addRow(columns.map((c) => cellValue(c, c.value(row))));
  }

  if (options.totals && rows.length > 0) {
    const first = header.number + 1;
    const last = header.number + rows.length;
    const totals = sheet.addRow(
      columns.map((column, index) => {
        if (index === 0) return "TOTAL";
        if (!column.kind || column.kind === "text" || column.total === false) return "";
        const letter = sheet.getColumn(index + 1).letter;
        const sum = rows.reduce((acc, row) => acc + (column.value(row) as number), 0);
        return {
          formula: `SUM(${letter}${first}:${letter}${last})`,
          result: column.kind === "duration" ? sum / 1440 : sum,
        };
      }),
    );
    totals.font = { bold: true };
    totals.eachCell((cell) => {
      cell.border = { top: { style: "medium" } };
    });
  }

  columns.forEach((column, index) => {
    const sheetColumn = sheet.getColumn(index + 1);
    sheetColumn.width = column.width;
    if (column.kind === "duration") sheetColumn.numFmt = DURATION_FORMAT;
  });
  sheet.views = [{ state: "frozen", ySplit: header.number }];
  sheet.autoFilter = {
    from: { row: header.number, column: 1 },
    to: { row: header.number, column: columns.length },
  };
}

const SUMMARY: Column<PayrollRow>[] = [
  { header: "Codigo", width: 14, value: (r) => r.employeeCode },
  { header: "Colaborador", width: 28, value: (r) => r.fullName },
  { header: "Cargo", width: 22, value: (r) => r.jobTitle ?? "" },
  { header: "Sucursal", width: 18, value: (r) => r.branchName ?? "" },
  { header: "Dias trabajados", width: 16, kind: "number", value: (r) => r.daysWorked },
  { header: "Dias ausente", width: 14, kind: "number", value: (r) => r.daysAbsent },
  { header: "Horas programadas", width: 18, kind: "duration", value: (r) => r.scheduledMinutes },
  { header: "Horas trabajadas", width: 17, kind: "duration", value: (r) => r.regularMinutes },
  { header: "Horas ordinarias", width: 17, kind: "duration", value: (r) => r.ordinaryMinutes },
  { header: "Extra tramo 1", width: 14, kind: "duration", value: (r) => r.overtimeTier1Minutes },
  { header: "Extra tramo 2", width: 14, kind: "duration", value: (r) => r.overtimeTier2Minutes },
  { header: "Horas extra", width: 13, kind: "duration", value: (r) => r.overtimeMinutes },
  { header: "Horas nocturnas", width: 16, kind: "duration", value: (r) => r.nightMinutes },
  { header: "Jornadas nocturnas", width: 19, kind: "number", value: (r) => r.nightShifts },
  { header: "Refrigerio", width: 12, kind: "duration", value: (r) => r.lunchMinutes },
  { header: "Tardanza (min)", width: 15, kind: "number", value: (r) => r.tardinessMinutes },
  { header: "Salida anticipada (min)", width: 23, kind: "number", value: (r) => r.earlyLeaveMinutes },
  { header: "Exceso semanal", width: 16, kind: "duration", value: (r) => r.weeklyExcessMinutes },
  { header: "Incidencias", width: 13, kind: "number", value: (r) => r.incidentCount },
];

type Employee = AttendanceDetail["employees"][number];
type DayRow = { employee: Employee; day: Employee["days"][number]; show: (iso: string | null) => string };

function dayRows(detail: AttendanceDetail): DayRow[] {
  return detail.employees.flatMap((employee) => {
    // Fecha y hora local: en turno noche la salida cae al dia siguiente.
    const local = new Intl.DateTimeFormat("sv-SE", {
      timeZone: employee.timezone,
      dateStyle: "short",
      timeStyle: "short",
    });
    const show = (iso: string | null) => (iso ? local.format(new Date(iso)) : "");
    return employee.days.map((day) => ({ employee, day, show }));
  });
}

/** Lo que RRHH necesita leer de un dia: justificaciones primero, luego alertas. */
function observations({ day }: DayRow): string {
  return [...day.justifications, ...day.incidents.map((i) => i.message)].join(" | ");
}

const DETAIL: Column<DayRow>[] = [
  { header: "Codigo", width: 14, value: (r) => r.employee.employeeCode },
  { header: "Colaborador", width: 28, value: (r) => r.employee.fullName },
  { header: "Fecha de jornada", width: 17, value: (r) => r.day.date },
  // En turno partido hay varias sesiones: se listan todas.
  { header: "Entrada", width: 20, value: (r) => r.day.sessions.map((s) => r.show(s.inAt)).filter(Boolean).join(" / ") },
  { header: "Salida", width: 20, value: (r) => r.day.sessions.map((s) => r.show(s.outAt)).filter(Boolean).join(" / ") },
  { header: "Programadas", width: 14, kind: "duration", value: (r) => r.day.scheduledMinutes },
  { header: "Trabajadas", width: 13, kind: "duration", value: (r) => r.day.workedMinutes },
  { header: "Ordinarias", width: 13, kind: "duration", value: (r) => r.day.ordinaryMinutes },
  { header: "Extra tramo 1", width: 14, kind: "duration", value: (r) => r.day.overtimeTier1Minutes },
  { header: "Extra tramo 2", width: 14, kind: "duration", value: (r) => r.day.overtimeTier2Minutes },
  { header: "Nocturnas", width: 12, kind: "duration", value: (r) => r.day.nightMinutes },
  { header: "Tardanza (min)", width: 15, kind: "number", value: (r) => r.day.tardinessMinutes },
  { header: "Observaciones", width: 90, value: observations },
];

type IncidentRow = DayRow & { message: string; code: string };

const INCIDENTS: Column<IncidentRow>[] = [
  { header: "Codigo", width: 14, value: (r) => r.employee.employeeCode },
  { header: "Colaborador", width: 28, value: (r) => r.employee.fullName },
  { header: "Fecha de jornada", width: 17, value: (r) => r.day.date },
  { header: "Tipo", width: 26, value: (r) => r.code },
  { header: "Descripcion", width: 90, value: (r) => r.message },
];

/** Parametros aplicados, para poder reproducir el calculo a mano. */
function addRulesSheet(workbook: ExcelJS.Workbook, detail: AttendanceDetail): void {
  const sheet = workbook.addWorksheet("Parametros");
  sheet.getColumn(1).width = 48;
  sheet.getColumn(2).width = 22;
  const { rules, payReference: pay } = detail;
  const money = (value: number | null) =>
    value === null ? "RMV no configurada" : `${pay.currency} ${value.toFixed(2)}`;
  sheet.addRows([
    ["Jornada ordinaria diaria sin turno", hhmm(rules.dailyOrdinaryMinutes)],
    ["Jornada ordinaria semanal", hhmm(rules.weeklyOrdinaryMinutes)],
    ["Duracion del tramo 1 de sobretiempo", hhmm(rules.overtimeTier1Minutes)],
    ["Factor del valor hora, tramo 1", pay.overtimeTier1Factor],
    ["Factor del valor hora, tramo 2", pay.overtimeTier2Factor],
    ["Horario nocturno", `${rules.nightStartTime} a ${rules.nightEndTime}`],
    ["Sobretasa nocturna minima (%)", rules.nightSurchargePct],
    ["RMV configurada", money(pay.minimumWage)],
    ["Valor hora de la RMV", money(pay.minimumWageHourly)],
    ["Sobretasa nocturna por hora (sobre RMV)", money(pay.nightSurchargePerHour)],
    ["Piso mensual del trabajador nocturno", money(pay.nightMinimumMonthly)],
    ["Nota", "Las horas son calculo del sistema; la valorizacion final corresponde a planillas."],
  ]);
}

export async function buildExcel(
  rows: PayrollRow[],
  range: { from: string; to: string },
  detail: AttendanceDetail | null,
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Scire 360 Chronos";
  workbook.created = new Date();
  const period = `${range.from} a ${range.to}`;

  addTable(workbook.addWorksheet("Resumen"), SUMMARY, rows, {
    title: `Resumen por trabajador · ${period}`,
    totals: true,
  });

  if (detail) {
    const days = dayRows(detail);
    addTable(workbook.addWorksheet("Detalle diario"), DETAIL, days, {
      title: `Detalle por jornada · ${period}`,
      totals: true,
    });
    const incidents = days.flatMap((row) =>
      row.day.incidents.map((i) => ({ ...row, code: i.code, message: i.message })),
    );
    addTable(workbook.addWorksheet("Incidencias"), INCIDENTS, incidents, {
      title: `Incidencias · ${period}`,
    });
    addRulesSheet(workbook, detail);
  }

  return Buffer.from(await workbook.xlsx.writeBuffer());
}
