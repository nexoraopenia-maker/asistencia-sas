"use client";

import { Download, FileSpreadsheet, FileText, TrendingUp } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { toast } from "sonner";
import { api, qs } from "../lib/api";
import { daysAgo, formatMinutes, today } from "../lib/format";
import { useBranch } from "./branch-context";
import { PeriodPresets } from "./period-presets";
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "./ui";

interface Summary {
  totalEmployees: number;
  punctualityRate: number;
  absenteeismRate: number;
  overtimeMinutes: number;
  tardinessMinutes: number;
  workedMinutes: number;
  scheduledMinutes: number;
  alertCount: number;
  daily: { date: string; present: number; late: number; absent: number; workedMinutes: number }[];
}

interface PayrollRow {
  userId: string;
  fullName: string;
  employeeCode: string;
  branchName: string | null;
  daysWorked: number;
  daysAbsent: number;
  nightMinutes: number;
  overtimeTier1Minutes: number;
  overtimeTier2Minutes: number;
  incidentCount: number;
  regularMinutes: number;
  lunchMinutes: number;
  tardinessMinutes: number;
  earlyLeaveMinutes: number;
  overtimeMinutes: number;
}

/**
 * Paleta de las series.
 *
 * Turquesa para lo correcto, ambar para lo que requiere atencion y rosa para
 * lo que falta. Cada serie lleva ademas su etiqueta en la leyenda: el color
 * refuerza el significado, nunca es el unico canal que lo transmite.
 */
const SERIES = {
  present: "#14b8a6",
  late: "#f59e0b",
  absent: "#f43f5e",
  worked: "#8b5cf6",
} as const;

function KpiCard({
  label,
  value,
  hint,
  tone = "default",
}: {
  label: string;
  value: string;
  hint: string;
  tone?: "default" | "good" | "warn" | "bad";
}) {
  const toneClass = {
    default: "text-foreground",
    good: "text-state-success",
    warn: "text-state-warning",
    bad: "text-state-danger",
  }[tone];

  return (
    <Card className="p-5">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={`mt-2 text-3xl font-bold tabular-nums ${toneClass}`}>{value}</p>
      <p className="mt-1 text-xs text-muted-foreground">{hint}</p>
    </Card>
  );
}

export function ReportsView() {
  const { selectedId } = useBranch();
  const [range, setRange] = useState({ from: daysAgo(29), to: today() });
  const [summary, setSummary] = useState<Summary | null>(null);
  const [payroll, setPayroll] = useState<PayrollRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [downloading, setDownloading] = useState<string | null>(null);

  const load = useCallback(async () => {
    setIsLoading(true);
    try {
      const params = qs({ from: range.from, to: range.to, branchId: selectedId });
      const [summaryData, payrollData] = await Promise.all([
        api<Summary>(`/v1/reports/summary${params}`),
        api<PayrollRow[]>(`/v1/reports/payroll${params}`),
      ]);
      setSummary(summaryData);
      setPayroll(payrollData);
    } catch {
      toast.error("No pudimos cargar los reportes");
    } finally {
      setIsLoading(false);
    }
  }, [range.from, range.to, selectedId]);

  useEffect(() => {
    void load();
  }, [load]);

  const download = async (format: "xlsx" | "pdf") => {
    setDownloading(format);
    try {
      const response = await fetch(
        `/api/reports/payroll${qs({ from: range.from, to: range.to, branchId: selectedId, format })}`,
      );
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        toast.error(payload?.error?.message ?? "No se pudo generar el reporte");
        return;
      }

      // El archivo llega como blob y se descarga con un enlace efimero: asi el
      // navegador respeta el nombre del Content-Disposition sin abrir pestana.
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `nomina-${range.from}-${range.to}.${format}`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);

      toast.success(`Reporte ${format.toUpperCase()} descargado`, {
        description: `${payroll.length} colaboradores · ${range.from} a ${range.to}`,
      });
    } catch {
      toast.error("No se pudo descargar el reporte");
    } finally {
      setDownloading(null);
    }
  };

  return (
    <div className="space-y-6">
      <PeriodPresets range={range} onSelect={setRange} />
      <p className="text-xs text-muted-foreground">
        Las fechas son de jornada: un turno que termina de madrugada cuenta completo en el dia en
        que empezo.
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="from">Desde</Label>
          <Input
            id="from"
            type="date"
            value={range.from}
            max={range.to}
            onChange={(e) => setRange({ ...range, from: e.target.value })}
            className="w-40 tabular-nums"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="to">Hasta</Label>
          <Input
            id="to"
            type="date"
            value={range.to}
            min={range.from}
            onChange={(e) => setRange({ ...range, to: e.target.value })}
            className="w-40 tabular-nums"
          />
        </div>

        <div className="ml-auto flex gap-2">
          <Button variant="outline" onClick={() => void download("xlsx")} disabled={downloading !== null}>
            <FileSpreadsheet />
            {downloading === "xlsx" ? "Generando..." : "Excel"}
          </Button>
          <Button variant="outline" onClick={() => void download("pdf")} disabled={downloading !== null}>
            <FileText />
            {downloading === "pdf" ? "Generando..." : "PDF"}
          </Button>
        </div>
      </div>

      {isLoading ? (
        <div className="space-y-6">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {Array.from({ length: 4 }).map((_, index) => (
              <Skeleton key={index} className="h-28" />
            ))}
          </div>
          <Skeleton className="h-80" />
        </div>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <KpiCard
              label="Puntualidad"
              value={`${summary?.punctualityRate ?? 0}%`}
              hint="jornadas iniciadas a tiempo"
              tone={(summary?.punctualityRate ?? 0) >= 90 ? "good" : "warn"}
            />
            <KpiCard
              label="Ausentismo"
              value={`${summary?.absenteeismRate ?? 0}%`}
              hint="jornadas con turno y sin marcacion"
              tone={(summary?.absenteeismRate ?? 0) > 5 ? "bad" : "good"}
            />
            <KpiCard
              label="Horas extra"
              value={formatMinutes(summary?.overtimeMinutes ?? 0)}
              hint="por encima de lo programado"
            />
            <KpiCard
              label="Tardanza acumulada"
              value={`${summary?.tardinessMinutes ?? 0} min`}
              hint={`${summary?.alertCount ?? 0} marcaciones con alerta`}
              tone={(summary?.tardinessMinutes ?? 0) > 0 ? "warn" : "good"}
            />
          </div>

          <div className="grid gap-4 xl:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Asistencia diaria</CardTitle>
                <CardDescription>Presentes, tardanzas y ausencias por dia</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="h-64">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={summary?.daily ?? []}>
                      <CartesianGrid strokeDasharray="3 3" stroke="currentColor" strokeOpacity={0.1} vertical={false} />
                      <XAxis
                        dataKey="date"
                        tickFormatter={(value: string) => value.slice(5)}
                        tick={{ fontSize: 11 }}
                        stroke="currentColor"
                        strokeOpacity={0.4}
                      />
                      <YAxis allowDecimals={false} tick={{ fontSize: 11 }} stroke="currentColor" strokeOpacity={0.4} />
                      <Tooltip
                        contentStyle={{
                          background: "hsl(var(--card))",
                          border: "1px solid hsl(var(--border))",
                          borderRadius: 12,
                          fontSize: 12,
                        }}
                      />
                      <Legend wrapperStyle={{ fontSize: 12 }} />
                      <Bar dataKey="present" name="Puntual" stackId="a" fill={SERIES.present} radius={[0, 0, 0, 0]} />
                      <Bar dataKey="late" name="Tardanza" stackId="a" fill={SERIES.late} />
                      <Bar dataKey="absent" name="Ausente" stackId="a" fill={SERIES.absent} radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Horas trabajadas</CardTitle>
                <CardDescription>Minutos efectivos por dia, sin refrigerio</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="h-64">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={summary?.daily ?? []}>
                      <CartesianGrid strokeDasharray="3 3" stroke="currentColor" strokeOpacity={0.1} vertical={false} />
                      <XAxis
                        dataKey="date"
                        tickFormatter={(value: string) => value.slice(5)}
                        tick={{ fontSize: 11 }}
                        stroke="currentColor"
                        strokeOpacity={0.4}
                      />
                      <YAxis
                        tickFormatter={(value: number) => `${Math.round(value / 60)}h`}
                        tick={{ fontSize: 11 }}
                        stroke="currentColor"
                        strokeOpacity={0.4}
                      />
                      <Tooltip
                        formatter={(value) => [formatMinutes(Number(value ?? 0)), "Trabajado"]}
                        contentStyle={{
                          background: "hsl(var(--card))",
                          border: "1px solid hsl(var(--border))",
                          borderRadius: 12,
                          fontSize: 12,
                        }}
                      />
                      <Line
                        type="monotone"
                        dataKey="workedMinutes"
                        name="Trabajado"
                        stroke={SERIES.worked}
                        strokeWidth={2}
                        dot={false}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </CardContent>
            </Card>
          </div>

          <Card className="overflow-hidden">
            <CardHeader>
              <CardTitle>Desglose por colaborador</CardTitle>
              <CardDescription>
                Horas, tramo nocturno, sobretiempo por tramos (T1/T2) e incidencias del periodo
              </CardDescription>
            </CardHeader>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Colaborador</TableHead>
                  <TableHead>Sucursal</TableHead>
                  <TableHead className="text-right">Dias</TableHead>
                  <TableHead className="text-right">Trabajadas</TableHead>
                  <TableHead className="text-right">Nocturnas</TableHead>
                  <TableHead className="text-right">Refrigerio</TableHead>
                  <TableHead className="text-right">Tardanza</TableHead>
                  <TableHead className="text-right">Salida ant.</TableHead>
                  <TableHead className="text-right">Extra T1</TableHead>
                  <TableHead className="text-right">Extra T2</TableHead>
                  <TableHead className="text-right">Incid.</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {payroll.map((row) => (
                  <TableRow key={row.userId}>
                    <TableCell>
                      <p className="font-medium">{row.fullName}</p>
                      <p className="text-xs text-muted-foreground">ID {row.employeeCode}</p>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{row.branchName ?? "—"}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {row.daysWorked}
                      {row.daysAbsent > 0 && (
                        <span className="ml-1 text-xs text-state-danger">-{row.daysAbsent}</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right font-medium tabular-nums">
                      {formatMinutes(row.regularMinutes)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">
                      {formatMinutes(row.nightMinutes)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">
                      {formatMinutes(row.lunchMinutes)}
                    </TableCell>
                    <TableCell
                      className={`text-right tabular-nums ${row.tardinessMinutes > 0 ? "text-state-warning" : "text-muted-foreground"}`}
                    >
                      {row.tardinessMinutes} min
                    </TableCell>
                    <TableCell
                      className={`text-right tabular-nums ${row.earlyLeaveMinutes > 0 ? "text-state-warning" : "text-muted-foreground"}`}
                    >
                      {row.earlyLeaveMinutes} min
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-state-success">
                      {formatMinutes(row.overtimeTier1Minutes)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-state-success">
                      {formatMinutes(row.overtimeTier2Minutes)}
                    </TableCell>
                    <TableCell
                      className={`text-right tabular-nums ${row.incidentCount > 0 ? "text-state-warning" : "text-muted-foreground"}`}
                    >
                      {row.incidentCount}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>

            {payroll.length === 0 && (
              <div className="flex flex-col items-center gap-2 py-12 text-center">
                <TrendingUp className="h-7 w-7 text-muted-foreground" />
                <p className="text-sm text-muted-foreground">
                  No hay datos de asistencia en el periodo seleccionado
                </p>
              </div>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
