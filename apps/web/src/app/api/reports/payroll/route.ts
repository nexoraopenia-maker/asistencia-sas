import { NextResponse, type NextRequest } from "next/server";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { apiFetch } from "../../../../lib/server-api";
import { setSessionCookies } from "../../../../lib/session";
import { buildExcel } from "../../../../lib/report-excel";
import { hhmm, type AttendanceDetail, type PayrollRow } from "../../../../lib/report-types";

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

async function buildPdf(rows: PayrollRow[], range: { from: string; to: string }): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  // A4 apaisado: once columnas no caben en vertical de forma legible.
  const PAGE = { width: 842, height: 595 };
  const MARGIN = 32;
  const ROW_HEIGHT = 18;

  const headers = ["Codigo", "Colaborador", "Sucursal", "Dias", "Trabajadas", "Nocturnas", "Tard.", "Salida ant.", "Extra T1", "Extra T2", "Incid."];
  const widths = [70, 160, 90, 35, 65, 65, 40, 60, 55, 55, 40];

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
      hhmm(row.nightMinutes),
      String(row.tardinessMinutes),
      String(row.earlyLeaveMinutes),
      hhmm(row.overtimeTier1Minutes),
      hhmm(row.overtimeTier2Minutes),
      String(row.incidentCount),
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

  const detail = await apiFetch(`/api/v1/reports/detail?${query.toString()}`);
  if (detail.rotatedTokens) await setSessionCookies(detail.rotatedTokens);
  // 404 = API sin actualizar: se entrega al menos el resumen en vez de fallar.
  if (detail.status !== 200 && detail.status !== 404) {
    return NextResponse.json(detail.body ?? { success: false }, { status: detail.status });
  }

  const excel = await buildExcel(
    rows,
    { from, to },
    detail.status === 200 ? (detail.body as { data: AttendanceDetail }).data : null,
  );
  return new NextResponse(new Uint8Array(excel), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${filename}.xlsx"`,
    },
  });
}
