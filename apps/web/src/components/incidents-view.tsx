"use client";

import { ABSENCE_LABELS, IncidentCode, type AbsenceType } from "@scire/shared";
import { Download } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { ApiError, api, qs } from "../lib/api";
import { daysAgo, today } from "../lib/format";
import type { AttendanceDetail } from "../lib/report-types";
import { useBranch } from "./branch-context";
import { AbsenceDialog, ManualPunchDialog, type ActionTarget } from "./incident-actions";
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

const LABELS: Record<IncidentCode, string> = {
  MISSING_OUT: "Salida faltante",
  ORPHAN_PUNCH: "Sin entrada",
  OPEN_BREAK: "Refrigerio sin cierre",
  ABSENT: "Falta",
  LATE: "Tardanza",
  EARLY_LEAVE: "Salida anticipada",
  OUTSIDE_GEOFENCE: "Fuera de geocerca",
  MOCK_LOCATION: "GPS simulado",
  SUSPICIOUS: "Sospechosa",
  NEAR_DUPLICATE: "Posible duplicado",
  DEBOUNCED_READ: "Lectura repetida",
  UNSCHEDULED_WORK: "Trabajo sin turno",
  OVERTIME_NOT_AUTHORIZED: "Extra sin autorizar",
  WEEKLY_EXCESS: "Exceso semanal",
};

/** Las que se corrigen agregando la marcacion que falta. */
const FIXABLE = new Set<string>(["MISSING_OUT", "ORPHAN_PUNCH", "OPEN_BREAK"]);
const MAX_ROWS = 200;

interface PendingAbsence {
  id: string;
  type: AbsenceType;
  startDate: string;
  endDate: string;
  reason: string;
  user: { fullName: string };
}

export function IncidentsView() {
  const { selectedId } = useBranch();
  const [range, setRange] = useState({ from: daysAgo(14), to: today() });
  const [detail, setDetail] = useState<AttendanceDetail | null>(null);
  const [pending, setPending] = useState<PendingAbsence[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<IncidentCode | null>(null);
  const [action, setAction] = useState<{ kind: "punch" | "absence"; target: ActionTarget } | null>(
    null,
  );

  const load = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const params = qs({ from: range.from, to: range.to, branchId: selectedId });
      const [detailData, absences] = await Promise.all([
        api<AttendanceDetail>(`/v1/reports/detail${params}`),
        api<PendingAbsence[]>(`/v1/absences${qs({ status: "PENDING", branchId: selectedId })}`),
      ]);
      setDetail(detailData);
      setPending(absences);
    } catch (cause) {
      setDetail(null);
      setError(cause instanceof ApiError ? cause.message : "No pudimos cargar las incidencias");
    } finally {
      setIsLoading(false);
    }
  }, [range.from, range.to, selectedId]);

  useEffect(() => {
    void load();
  }, [load]);

  const rows = useMemo(
    () =>
      (detail?.employees ?? [])
        .flatMap((employee) =>
          employee.days.flatMap((day) =>
            day.incidents.map((incident) => ({ employee, day, incident })),
          ),
        )
        .sort((a, b) => b.day.date.localeCompare(a.day.date)),
    [detail],
  );
  const counts = useMemo(() => {
    const map = new Map<IncidentCode, number>();
    for (const { incident } of rows) map.set(incident.code, (map.get(incident.code) ?? 0) + 1);
    return map;
  }, [rows]);
  const compliance = useMemo(
    () =>
      (detail?.employees ?? [])
        .map((employee) => {
          const scheduled = employee.days.filter(
            (d) => d.hasShift && !d.isJustified && (d.hasPunches || d.isAbsent),
          );
          const ok = scheduled.filter((d) => d.isComplete && !d.isLate && !d.earlyLeaveMinutes);
          return {
            employee,
            scheduled: scheduled.length,
            ok: ok.length,
            absent: employee.days.filter((d) => d.isAbsent).length,
            late: employee.days.filter((d) => d.isLate).length,
            rate: scheduled.length ? Math.round((ok.length / scheduled.length) * 100) : null,
          };
        })
        .sort((a, b) => (a.rate ?? 101) - (b.rate ?? 101)),
    [detail],
  );

  const visible = filter ? rows.filter((r) => r.incident.code === filter) : rows;

  const review = async (id: string, status: "APPROVED" | "REJECTED") => {
    try {
      await api(`/v1/absences/${id}/review`, { method: "POST", body: { status } });
      toast.success(status === "APPROVED" ? "Solicitud aprobada" : "Solicitud rechazada");
      void load();
    } catch (cause) {
      toast.error(cause instanceof ApiError ? cause.message : "No se pudo resolver");
    }
  };

  const done = () => {
    setAction(null);
    void load();
  };

  return (
    <div className="space-y-6">
      <PeriodPresets range={range} onSelect={setRange} />
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="from">Desde</Label>
          <Input id="from" type="date" value={range.from} max={range.to} className="w-40"
            onChange={(e) => setRange({ ...range, from: e.target.value })} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="to">Hasta</Label>
          <Input id="to" type="date" value={range.to} min={range.from} className="w-40"
            onChange={(e) => setRange({ ...range, to: e.target.value })} />
        </div>
        <Button asChild variant="outline" className="ml-auto">
          <a href={`/api/reports/payroll${qs({ ...range, branchId: selectedId, format: "xlsx" })}`}>
            <Download />
            Consolidado Excel
          </a>
        </Button>
      </div>

      {isLoading ? (
        <Skeleton className="h-96" />
      ) : error ? (
        <Card className="p-6 text-sm text-state-danger">{error}</Card>
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant={filter ? "outline" : "default"} onClick={() => setFilter(null)}>
              Todas ({rows.length})
            </Button>
            {Object.values(IncidentCode)
              .filter((code) => counts.has(code))
              .map((code) => (
                <Button key={code} size="sm" variant={filter === code ? "default" : "outline"}
                  onClick={() => setFilter(code)}>
                  {LABELS[code]} ({counts.get(code)})
                </Button>
              ))}
          </div>

          {pending.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Solicitudes pendientes</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {pending.map((item) => (
                  <div key={item.id}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border p-4">
                    <div className="min-w-0">
                      <p className="font-medium">
                        {item.user.fullName} · {ABSENCE_LABELS[item.type]}
                      </p>
                      <p className="text-sm text-muted-foreground">
                        {item.startDate} a {item.endDate} · {item.reason}
                      </p>
                    </div>
                    <div className="flex gap-2">
                      <Button size="sm" onClick={() => void review(item.id, "APPROVED")}>Aprobar</Button>
                      <Button size="sm" variant="outline" onClick={() => void review(item.id, "REJECTED")}>
                        Rechazar
                      </Button>
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle>Incidencias</CardTitle>
              <CardDescription>
                {visible.length > MAX_ROWS
                  ? `Mostrando ${MAX_ROWS} de ${visible.length}. Acota el periodo o descarga el Excel.`
                  : `${visible.length} en el periodo`}
              </CardDescription>
            </CardHeader>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Jornada</TableHead>
                  <TableHead>Colaborador</TableHead>
                  <TableHead>Incidencia</TableHead>
                  <TableHead className="text-right">Acciones</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.slice(0, MAX_ROWS).map(({ employee, day, incident }, index) => {
                  const target = { userId: employee.userId, fullName: employee.fullName, date: day.date };
                  return (
                    <TableRow key={`${employee.userId}-${day.date}-${incident.code}-${index}`}>
                      <TableCell className="tabular-nums">{day.date}</TableCell>
                      <TableCell className="font-medium">{employee.fullName}</TableCell>
                      <TableCell>
                        <p>{LABELS[incident.code]}</p>
                        <p className="text-xs text-muted-foreground">{incident.message}</p>
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-2">
                          {FIXABLE.has(incident.code) && (
                            <Button size="sm" onClick={() => setAction({ kind: "punch", target })}>
                              Regularizar
                            </Button>
                          )}
                          <Button size="sm" variant="outline"
                            onClick={() => setAction({ kind: "absence", target })}>
                            Justificar
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
            {visible.length === 0 && (
              <p className="py-10 text-center text-sm text-muted-foreground">
                Sin incidencias en el periodo
              </p>
            )}
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Cumplimiento por colaborador</CardTitle>
              <CardDescription>
                Jornadas con turno completas, puntuales y sin salida anticipada.
              </CardDescription>
            </CardHeader>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Colaborador</TableHead>
                  <TableHead className="text-right">Con turno</TableHead>
                  <TableHead className="text-right">Cumplidas</TableHead>
                  <TableHead className="text-right">Faltas</TableHead>
                  <TableHead className="text-right">Tardanzas</TableHead>
                  <TableHead className="text-right">Cumplimiento</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {compliance.map((row) => (
                  <TableRow key={row.employee.userId}>
                    <TableCell className="font-medium">{row.employee.fullName}</TableCell>
                    <TableCell className="text-right tabular-nums">{row.scheduled}</TableCell>
                    <TableCell className="text-right tabular-nums">{row.ok}</TableCell>
                    <TableCell className="text-right tabular-nums">{row.absent}</TableCell>
                    <TableCell className="text-right tabular-nums">{row.late}</TableCell>
                    <TableCell className="text-right font-medium tabular-nums">
                      {row.rate === null ? "—" : `${row.rate}%`}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        </>
      )}

      {action?.kind === "punch" && (
        <ManualPunchDialog target={action.target} onClose={() => setAction(null)} onDone={done} />
      )}
      {action?.kind === "absence" && (
        <AbsenceDialog target={action.target} onClose={() => setAction(null)} onDone={done} />
      )}
    </div>
  );
}
