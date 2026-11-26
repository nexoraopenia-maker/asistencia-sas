"use client";

import { ABSENCE_LABELS, AbsenceType } from "@scire/shared";
import { useState } from "react";
import { toast } from "sonner";
import { ApiError, api } from "../lib/api";
import { PUNCH_LABELS } from "../lib/format";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui";

export interface ActionTarget {
  userId: string;
  fullName: string;
  date: string;
}

interface DialogProps {
  target: ActionTarget;
  onClose: () => void;
  onDone: () => void;
}

function useSubmit(onDone: () => void) {
  const [isSaving, setIsSaving] = useState(false);
  const submit = async (path: string, body: unknown, success: string) => {
    setIsSaving(true);
    try {
      await api(path, { method: "POST", body });
      toast.success(success);
      onDone();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : "No se pudo guardar");
    } finally {
      setIsSaving(false);
    }
  };
  return { isSaving, submit };
}

function Footer({ isSaving, onClose }: { isSaving: boolean; onClose: () => void }) {
  return (
    <div className="flex justify-end gap-2">
      <Button type="button" variant="outline" onClick={onClose}>
        Cancelar
      </Button>
      <Button type="submit" disabled={isSaving}>
        {isSaving ? "Guardando..." : "Guardar"}
      </Button>
    </div>
  );
}

/** Agrega la marcacion que falta, con motivo auditado. */
export function ManualPunchDialog({ target, onClose, onDone }: DialogProps) {
  const [form, setForm] = useState({ punchType: "OUT", date: target.date, time: "", reason: "" });
  const { isSaving, submit } = useSubmit(onDone);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Regularizar marcacion</DialogTitle>
          <DialogDescription>
            {target.fullName} · jornada del {target.date}. En turno noche, la salida suele ser del
            dia siguiente. Queda registrado en auditoria.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit(
              "/v1/punch/manual",
              { userId: target.userId, ...form },
              "Marcacion regularizada",
            );
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="punchType">Tipo</Label>
            <Select value={form.punchType} onValueChange={(punchType) => setForm({ ...form, punchType })}>
              <SelectTrigger id="punchType">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(PUNCH_LABELS).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="date">Fecha real</Label>
              <Input id="date" type="date" required value={form.date}
                onChange={(e) => setForm({ ...form, date: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="time">Hora local</Label>
              <Input id="time" type="time" required value={form.time}
                onChange={(e) => setForm({ ...form, time: e.target.value })} />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="reason">Motivo</Label>
            <Input id="reason" required minLength={10} value={form.reason}
              onChange={(e) => setForm({ ...form, reason: e.target.value })} />
          </div>
          <Footer isSaving={isSaving} onClose={onClose} />
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Registra una ausencia o justificacion ya aprobada por RRHH. */
export function AbsenceDialog({ target, onClose, onDone }: DialogProps) {
  const [form, setForm] = useState({
    type: AbsenceType.MEDICAL_LEAVE as string,
    startDate: target.date,
    endDate: target.date,
    reason: "",
    minutes: "",
  });
  const { isSaving, submit } = useSubmit(onDone);
  const isOvertime = form.type === AbsenceType.OVERTIME_REQUEST;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Registrar justificacion</DialogTitle>
          <DialogDescription>{target.fullName}. Se guarda como aprobada.</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            const { minutes, ...rest } = form;
            void submit(
              "/v1/absences",
              {
                ...rest,
                userId: target.userId,
                approve: true,
                ...(isOvertime ? { requestedMinutes: Number(minutes) } : {}),
              },
              "Justificacion registrada",
            );
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="absenceType">Tipo</Label>
            <Select value={form.type} onValueChange={(type) => setForm({ ...form, type })}>
              <SelectTrigger id="absenceType">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(ABSENCE_LABELS).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="startDate">Desde</Label>
              <Input id="startDate" type="date" required value={form.startDate}
                onChange={(e) => setForm({ ...form, startDate: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="endDate">Hasta</Label>
              <Input id="endDate" type="date" required min={form.startDate} value={form.endDate}
                onChange={(e) => setForm({ ...form, endDate: e.target.value })} />
            </div>
          </div>
          {isOvertime && (
            <div className="space-y-2">
              <Label htmlFor="minutes">Minutos de horas extra por dia</Label>
              <Input id="minutes" type="number" required min={1} max={1440} value={form.minutes}
                onChange={(e) => setForm({ ...form, minutes: e.target.value })} />
            </div>
          )}
          <div className="space-y-2">
            <Label htmlFor="absenceReason">Motivo</Label>
            <Input id="absenceReason" required minLength={5} value={form.reason}
              onChange={(e) => setForm({ ...form, reason: e.target.value })} />
          </div>
          <Footer isSaving={isSaving} onClose={onClose} />
        </form>
      </DialogContent>
    </Dialog>
  );
}
