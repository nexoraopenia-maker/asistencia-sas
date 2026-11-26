"use client";

import { CalendarPlus, ChevronLeft, ChevronRight, Save } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { ApiError, api, qs } from "../lib/api";
import { today } from "../lib/format";
import { useBranch } from "./branch-context";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
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

const WEEKDAYS = ["Dom", "Lun", "Mar", "Mie", "Jue", "Vie", "Sab"];

/** Los 7 dias (domingo -> sabado) de la semana que contiene `date`. */
function weekOf(date: string): string[] {
  const anchor = new Date(`${date}T12:00:00.000Z`);
  const sunday = new Date(anchor);
  sunday.setUTCDate(anchor.getUTCDate() - anchor.getUTCDay());
  return Array.from({ length: 7 }, (_, index) => {
    const day = new Date(sunday);
    day.setUTCDate(sunday.getUTCDate() + index);
    return day.toISOString().slice(0, 10);
  });
}

function shiftWeek(date: string, weeks: number): string {
  const anchor = new Date(`${date}T12:00:00.000Z`);
  anchor.setUTCDate(anchor.getUTCDate() + weeks * 7);
  return anchor.toISOString().slice(0, 10);
}

interface Employee {
  id: string;
  fullName: string;
  employeeCode: string;
  branch: { id: string; name: string } | null;
}

interface DayCell {
  date: string;
  work: { startTime: string; endTime: string } | null;
  lunch: { startTime: string; endTime: string } | null;
}

/** Plantilla horaria aplicada de forma masiva. */
function BulkAssignDialog({
  employees,
  weekDays,
  onDone,
}: {
  employees: Employee[];
  weekDays: string[];
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [weekdays, setWeekdays] = useState<Set<number>>(new Set([1, 2, 3, 4, 5]));
  const [form, setForm] = useState({
    workStart: "09:00:00",
    workEnd: "18:00:00",
    lunchStart: "13:00:00",
    lunchEnd: "14:00:00",
    overwriteExisting: false,
  });

  const toggle = <T,>(set: Set<T>, value: T): Set<T> => {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    return next;
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (selected.size === 0) {
      toast.error("Selecciona al menos un colaborador");
      return;
    }
    setIsSaving(true);
    try {
      const result = await api<{ created: number; skipped: number; days: number }>(
        "/v1/shifts/bulk-assign",
        {
          method: "POST",
          body: {
            userIds: [...selected],
            from: weekDays[0],
            to: weekDays[6],
            weekdays: [...weekdays],
            overwriteExisting: form.overwriteExisting,
            blocks: [
              { type: "WORK", startTime: form.workStart, endTime: form.workEnd },
              { type: "LUNCH", startTime: form.lunchStart, endTime: form.lunchEnd },
            ],
          },
        },
      );

      toast.success(`${result.created} tramos asignados`, {
        description:
          result.skipped > 0
            ? `${result.skipped} ya existian y se respetaron.`
            : `${selected.size} colaborador(es) sobre ${result.days} dias.`,
      });
      setOpen(false);
      onDone();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : "No se pudo asignar la plantilla");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button onClick={() => setOpen(true)}>
        <CalendarPlus />
        Asignacion masiva
      </Button>

      <DialogContent>
        <DialogHeader>
          <DialogTitle>Asignar plantilla horaria</DialogTitle>
          <DialogDescription>
            Se aplicara del {weekDays[0]} al {weekDays[6]}.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="space-y-5">
          <fieldset>
            <legend className="mb-2 text-sm font-medium">Dias de la semana</legend>
            <div className="flex flex-wrap gap-1.5">
              {WEEKDAYS.map((label, index) => (
                <Button
                  key={label}
                  type="button"
                  size="sm"
                  variant={weekdays.has(index) ? "default" : "outline"}
                  aria-pressed={weekdays.has(index)}
                  onClick={() => setWeekdays((current) => toggle(current, index))}
                >
                  {label}
                </Button>
              ))}
            </div>
          </fieldset>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="workStart">Trabajo desde</Label>
              <Input
                id="workStart"
                value={form.workStart}
                onChange={(e) => setForm({ ...form, workStart: e.target.value })}
                pattern="^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$"
                placeholder="09:00:00"
                required
                className="tabular-nums"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="workEnd">Trabajo hasta</Label>
              <Input
                id="workEnd"
                value={form.workEnd}
                onChange={(e) => setForm({ ...form, workEnd: e.target.value })}
                pattern="^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$"
                required
                className="tabular-nums"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="lunchStart">Refrigerio desde</Label>
              <Input
                id="lunchStart"
                value={form.lunchStart}
                onChange={(e) => setForm({ ...form, lunchStart: e.target.value })}
                pattern="^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$"
                required
                className="tabular-nums"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="lunchEnd">Refrigerio hasta</Label>
              <Input
                id="lunchEnd"
                value={form.lunchEnd}
                onChange={(e) => setForm({ ...form, lunchEnd: e.target.value })}
                pattern="^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$"
                required
                className="tabular-nums"
              />
            </div>
          </div>

          <fieldset>
            <legend className="mb-2 text-sm font-medium">
              Colaboradores ({selected.size} seleccionados)
            </legend>
            <div className="max-h-48 space-y-1 overflow-y-auto rounded-xl border border-border p-2">
              {employees.map((employee) => (
                <label
                  key={employee.id}
                  className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-secondary"
                >
                  <input
                    type="checkbox"
                    checked={selected.has(employee.id)}
                    onChange={() => setSelected((current) => toggle(current, employee.id))}
                    className="h-4 w-4 accent-[hsl(var(--primary))]"
                  />
                  <span className="flex-1 truncate">{employee.fullName}</span>
                  <span className="text-xs text-muted-foreground">{employee.employeeCode}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={form.overwriteExisting}
              onChange={(e) => setForm({ ...form, overwriteExisting: e.target.checked })}
              className="h-4 w-4 accent-[hsl(var(--primary))]"
            />
            Reemplazar los turnos que ya existan en esas fechas
          </label>

          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancelar
            </Button>
            <Button type="submit" disabled={isSaving}>
              {isSaving ? "Asignando..." : "Aplicar plantilla"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Panel de tolerancias: se edita aqui porque es donde se piensa en horarios. */
function ToleranceSettings() {
  const [values, setValues] = useState({ late: 10, earlyLeave: 10 });
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const company = await api<{
          lateToleranceMinutes: number;
          earlyLeaveToleranceMinutes: number;
        }>("/v1/company");
        setValues({
          late: company.lateToleranceMinutes,
          earlyLeave: company.earlyLeaveToleranceMinutes,
        });
      } finally {
        setIsLoading(false);
      }
    })();
  }, []);

  const save = async () => {
    setIsSaving(true);
    try {
      await api("/v1/company", {
        method: "PATCH",
        body: {
          lateToleranceMinutes: values.late,
          earlyLeaveToleranceMinutes: values.earlyLeave,
        },
      });
      toast.success("Tolerancias actualizadas", {
        description: "Se aplican a las marcaciones futuras; las ya registradas no cambian.",
      });
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : "No se pudo guardar");
    } finally {
      setIsSaving(false);
    }
  };

  if (isLoading) return <Skeleton className="h-44" />;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Reglas de la jornada</CardTitle>
        <CardDescription>
          Los cambios afectan solo a las marcaciones futuras. La tardanza de un registro ya
          existente se calculo con la regla vigente en aquel momento y no se recalcula.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="late">Tolerancia de tardanza (minutos)</Label>
            <Input
              id="late"
              type="number"
              min={0}
              max={120}
              value={values.late}
              onChange={(e) => setValues({ ...values, late: Number(e.target.value) })}
              className="tabular-nums"
            />
            <p className="text-xs text-muted-foreground">
              Minutos de gracia antes de contabilizar una tardanza.
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="early">Tolerancia de salida anticipada (minutos)</Label>
            <Input
              id="early"
              type="number"
              min={0}
              max={120}
              value={values.earlyLeave}
              onChange={(e) => setValues({ ...values, earlyLeave: Number(e.target.value) })}
              className="tabular-nums"
            />
            <p className="text-xs text-muted-foreground">
              Margen para cerrar la jornada antes del fin de turno.
            </p>
          </div>
        </div>

        <Button onClick={() => void save()} disabled={isSaving}>
          <Save />
          {isSaving ? "Guardando..." : "Guardar reglas"}
        </Button>
      </CardContent>
    </Card>
  );
}

export function ShiftMatrix() {
  const { selectedId } = useBranch();
  const [anchor, setAnchor] = useState(today());
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [matrix, setMatrix] = useState<Record<string, DayCell[]>>({});
  const [isLoading, setIsLoading] = useState(true);

  const weekDays = weekOf(anchor);

  const load = useCallback(async () => {
    setIsLoading(true);
    try {
      const list = await api<{ items: Employee[] }>(
        `/v1/users${qs({ pageSize: 100, branchId: selectedId, status: "ACTIVE" })}`,
      );
      setEmployees(list.items);

      // Una peticion por colaborador: la API expone el calendario por persona.
      // Con el tope de 100 empleados por pagina es asumible, y mantiene el
      // backend simple. Si una empresa crece por encima, el siguiente paso es
      // un endpoint de calendario por sucursal, no mas concurrencia aqui.
      const schedules = await Promise.all(
        list.items.map((employee) =>
          api<{ days: { date: string; work: DayCell["work"]; lunch: DayCell["lunch"] }[] }>(
            `/v1/shifts/week${qs({ weekOf: anchor, userId: employee.id })}`,
          )
            .then((schedule) => [employee.id, schedule.days] as const)
            .catch(() => [employee.id, []] as const),
        ),
      );

      setMatrix(Object.fromEntries(schedules));
    } catch {
      toast.error("No pudimos cargar la matriz de turnos");
    } finally {
      setIsLoading(false);
    }
  }, [anchor, selectedId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1 rounded-xl border border-border p-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={() => setAnchor(shiftWeek(anchor, -1))}
            aria-label="Semana anterior"
          >
            <ChevronLeft />
          </Button>
          <span className="px-2 text-sm font-medium tabular-nums">
            {weekDays[0]} — {weekDays[6]}
          </span>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={() => setAnchor(shiftWeek(anchor, 1))}
            aria-label="Semana siguiente"
          >
            <ChevronRight />
          </Button>
        </div>

        <Button variant="outline" size="sm" onClick={() => setAnchor(today())}>
          Semana actual
        </Button>

        <div className="ml-auto">
          <BulkAssignDialog employees={employees} weekDays={weekDays} onDone={load} />
        </div>
      </div>

      {isLoading ? (
        <Skeleton className="h-80" />
      ) : employees.length === 0 ? (
        <Card className="py-16 text-center">
          <p className="font-semibold">No hay colaboradores activos</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Invita colaboradores antes de asignar turnos.
          </p>
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="sticky left-0 bg-card">Colaborador</TableHead>
                {weekDays.map((date, index) => (
                  <TableHead key={date} className="text-center">
                    {WEEKDAYS[index]}
                    <span className="ml-1 font-normal tabular-nums opacity-60">
                      {date.slice(8)}
                    </span>
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {employees.map((employee) => (
                <TableRow key={employee.id}>
                  <TableCell className="sticky left-0 bg-card">
                    <p className="whitespace-nowrap font-medium">{employee.fullName}</p>
                    <p className="text-xs text-muted-foreground">{employee.employeeCode}</p>
                  </TableCell>
                  {weekDays.map((date) => {
                    const cell = matrix[employee.id]?.find((day) => day.date === date);
                    return (
                      <TableCell key={date} className="text-center">
                        {cell?.work ? (
                          <div className="space-y-0.5">
                            <Badge variant="info" className="tabular-nums">
                              {cell.work.startTime.slice(0, 5)}–{cell.work.endTime.slice(0, 5)}
                            </Badge>
                            {cell.lunch && (
                              <p className="text-[10px] tabular-nums text-muted-foreground">
                                {cell.lunch.startTime.slice(0, 5)}–{cell.lunch.endTime.slice(0, 5)}
                              </p>
                            )}
                          </div>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </TableCell>
                    );
                  })}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}

      <ToleranceSettings />
    </div>
  );
}
