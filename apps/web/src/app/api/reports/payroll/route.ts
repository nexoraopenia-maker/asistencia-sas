import { NextResponse, type NextRequest } from "next/server";
import ExcelJS from "exceljs";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { apiFetch } from "../../../../lib/server-api";
import { setSessionCookies } from "../../../../lib/session";

/**
 * Exportacion de nomina en Excel y PDF.
 *
 * Se genera en el servidor de Next y no en el navegador por dos razones: el
 * token de la API vive en una cookie httpOnly que el cliente no puede leer, y
 * un informe de 150 colaboradores por 30 dias no deberia construirse en el hilo
 * principal de una pestana.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface PayrollRow {
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
}

/** `510` -> `8:30`. Las horas de nomina se leen en horas y minutos, no en decimales. */
function hhmm(minutes: number): string {
  const abs = Math.abs(Math.round(minutes));
  return `${Math.floor(abs / 60)}:${String(abs % 60).padStart(2, "0")}`;
}

const COLUMNS = [
  { header: "Codigo", key: "employeeCode", width: 14 },
  { header: "Colaborador", key: "fullName", width: 28 },
  { header: "Cargo", key: "jobTitle", width: 24 },
  { header: "Sucursal", key: "branchName", width: 18 },
  { header: "Dias trabajados", key: "daysWorked", width: 16 },
  { header: "Dias ausente", key: "daysAbsent", width: 14 },
  { header: "Horas regulares", key: "regular", width: 16 },
  { header: "Refrigerio", key: "lunch", width: 12 },
  { header: "Tardanza (min)", key: "tardiness", width: 15 },
  { header: "Salida anticipada (min)", key: "earlyLeave", width: 22 },
  { header: "Horas extra", key: "overtime", width: 13 },
] as const;

async function buildExcel(rows: PayrollRow[], range: { from: string; to: string }): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Scire 360 Chronos";
  workbook.created = new Date();

  const sheet = workbook.addWorksheet("Nomina", {
    views: [{ state: "frozen", ySplit: 3 }],
  });

  sheet.mergeCells("A1:K1");
  const title = sheet.getCell("A1");
  title.value = `Reporte de nomina · ${range.from} a ${range.to}`;
  title.font = { size: 14, bold: true };
  sheet.getRow(1).height = 24;

  sheet.getRow(2).values = [];

  const headerRow = sheet.getRow(3);
  headerRow.values = COLUMNS.map((column) => column.header);
  headerRow.font = { bold: true, color: { argb: "FFFFFFFF" } };
  headerRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF312E81" } };
  headerRow.alignment = { vertical: "middle" };
  headerRow.height = 20;

  COLUMNS.forEach((column, index) => {
    sheet.getColumn(index + 1).width = column.width;
  });

  for (const row of rows) {
    sheet.addRow([
      row.employeeCode,
      row.fullName,
      row.jobTitle ?? "",
      row.branchName ?? "",
      row.daysWorked,
      row.daysAbsent,
      hhmm(row.regularMinutes),
      hhmm(row.lunchMinutes),
      row.tardinessMinutes,
      row.earlyLeaveMinutes,
      hhmm(row.overtimeMinutes),
    ]);
  }

  // Fila de totales: es lo primero que busca quien revisa una nomina.
  const totals = sheet.addRow([
    "",
    `TOTAL (${rows.length})`,
    "",
    "",
    rows.reduce((sum, row) => sum + row.daysWorked, 0),
    rows.reduce((sum, row) => sum + row.daysAbsent, 0),
    hhmm(rows.reduce((sum, row) => sum + row.regularMinutes, 0)),
    hhmm(rows.reduce((sum, row) => sum + row.lunchMinutes, 0)),
    rows.reduce((sum, row) => sum + row.tardinessMinutes, 0),
    rows.reduce((sum, row) => sum + row.earlyLeaveMinutes, 0),
    hhmm(rows.reduce((sum, row) => sum + row.overtimeMinutes, 0)),
  ]);
  totals.font = { bold: true };
  totals.border = { top: { style: "medium" } };

  sheet.autoFilter = { from: { row: 3, column: 1 }, to: { row: 3, column: COLUMNS.length } };

  return Buffer.from(await workbook.xlsx.writeBuffer());
}

async function buildPdf(rows: PayrollRow[], range: { from: string; to: string }): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  // A4 apaisado: once columnas no caben en vertical de forma legible.
  const PAGE = { width: 842, height: 595 };
  const MARGIN = 32;
  const ROW_HEIGHT = 18;

  const headers = ["Codigo", "Colaborador", "Sucursal", "Dias", "Regulares", "Refrig.", "Tard.", "Salida ant.", "Extra"];
  const widths = [70, 170, 100, 45, 70, 60, 50, 75, 60];

  let page = pdf.addPage([PAGE.width, PAGE.height]);
  let y = PAGE.height - MARGIN;

  const drawHeader = () => {
    page.drawText("Scire 360 Chronos · Reporte de nomina", {
      x: MARGIN,
      y: y - 4,
      size: 14,
      font: bold,
      color: rgb(0.19, 0.18, 0.51),
    });
    y -= 20;
    page.drawText(`Periodo ${range.from} a ${range.to} · ${rows.length} colaboradores`, {
      x: MARGIN,
      y,
      size: 9,
      font,
      color: rgb(0.45, 0.45, 0.5),
    });
    y -= 22;

    let x = MARGIN;
    headers.forEach((header, index) => {
      page.drawText(header, { x, y, size: 8, font: bold, color: rgb(0.3, 0.3, 0.35) });
      x += widths[index]!;
    });
    y -= 6;
    page.drawLine({
      start: { x: MARGIN, y },
      end: { x: PAGE.width - MARGIN, y },
      thickness: 0.8,
      color: rgb(0.8, 0.8, 0.85),
    });
    y -= ROW_HEIGHT;
  };

  drawHeader();

  for (const row of rows) {
    // Salto de pagina antes de que la fila se salga del margen inferior.
    if (y < MARGIN + ROW_HEIGHT) {
      page = pdf.addPage([PAGE.width, PAGE.height]);
      y = PAGE.height - MARGIN;
      drawHeader();
    }

    const cells = [
      row.employeeCode,
      row.fullName.length > 30 ? `${row.fullName.slice(0, 29)}…` : row.fullName,
      row.branchName ?? "—",
      String(row.daysWorked),
      hhmm(row.regularMinutes),
      hhmm(row.lunchMinutes),
      String(row.tardinessMinutes),
      String(row.earlyLeaveMinutes),
      hhmm(row.overtimeMinutes),
    ];

    let x = MARGIN;
    cells.forEach((cell, index) => {
      page.drawText(cell, { x, y, size: 8, font, color: rgb(0.1, 0.1, 0.15) });
      x += widths[index]!;
    });
    y -= ROW_HEIGHT;
  }

  const pages = pdf.getPages();
  pages.forEach((current, index) => {
    current.drawText(
      `Generado el ${new Date().toISOString().slice(0, 10)} · Pagina ${index + 1} de ${pages.length}`,
      { x: MARGIN, y: 18, size: 7, font, color: rgb(0.55, 0.55, 0.6) },
    );
  });

  return Buffer.from(await pdf.save());
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const params = request.nextUrl.searchParams;
  const format = params.get("format") ?? "xlsx";
  const from = params.get("from");
  const to = params.get("to");
  const branchId = params.get("branchId");

  if (!from || !to) {
    return NextResponse.json(
      { success: false, error: { code: "VALIDATION_ERROR", message: "Indica el rango de fechas" } },
      { status: 422 },
    );
  }

  const query = new URLSearchParams({ from, to });
  if (branchId) query.set("branchId", branchId);

  const result = await apiFetch(`/api/v1/reports/payroll?${query.toString()}`);
  if (result.rotatedTokens) await setSessionCookies(result.rotatedTokens);

  if (result.status !== 200) {
    return NextResponse.json(result.body ?? { success: false }, { status: result.status });
  }

  const rows = (result.body as { data: PayrollRow[] }).data;
  const filename = `nomina-${from}-${to}`;

  if (format === "pdf") {
    const pdf = await buildPdf(rows, { from, to });
    return new NextResponse(new Uint8Array(pdf), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${filename}.pdf"`,
      },
    });
  }

  const excel = await buildExcel(rows, { from, to });
  return new NextResponse(new Uint8Array(excel), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${filename}.xlsx"`,
    },
  });
}
