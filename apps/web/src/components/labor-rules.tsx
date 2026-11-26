"use client";

import { Save } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { ApiError, api } from "../lib/api";
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label, Switch } from "./ui";

type Kind = "number" | "time" | "text";

interface Field {
  key: string;
  label: string;
  kind: Kind;
  /** Factor entre lo que se muestra y lo que se guarda (horas -> minutos). */
  scale?: number;
}

const GROUPS: { title: string; fields: Field[] }[] = [
  {
    title: "Jornada",
    fields: [
      { key: "dailyOrdinaryMinutes", label: "Jornada diaria sin turno (horas)", kind: "number", scale: 60 },
      { key: "weeklyOrdinaryMinutes", label: "Jornada semanal (horas)", kind: "number", scale: 60 },
      { key: "maxShiftHours", label: "Plazo maximo para marcar la salida (horas)", kind: "number" },
    ],
  },
  {
    title: "Sobretiempo",
    fields: [
      { key: "overtimeThresholdMinutes", label: "Minimo para computar (min)", kind: "number" },
      { key: "overtimeTier1Minutes", label: "Duracion del primer tramo (min)", kind: "number" },
      { key: "overtimeTier1RatePct", label: "Sobretasa primer tramo (%)", kind: "number" },
      { key: "overtimeTier2RatePct", label: "Sobretasa segundo tramo (%)", kind: "number" },
    ],
  },
  {
    title: "Horario nocturno y referencia salarial",
    fields: [
      { key: "nightStartTime", label: "Inicio nocturno", kind: "time" },
      { key: "nightEndTime", label: "Fin nocturno", kind: "time" },
      { key: "nightSurchargePct", label: "Sobretasa nocturna (%)", kind: "number" },
      { key: "nightShiftMinSharePct", label: "% nocturno para llamarla jornada nocturna", kind: "number" },
      { key: "minimumWage", label: "Remuneracion Minima Vital vigente", kind: "number" },
      { key: "payrollCurrency", label: "Moneda (ISO)", kind: "text" },
      { key: "hourlyDivisor", label: "Divisor para el valor hora", kind: "number" },
    ],
  },
];

const FIELDS = GROUPS.flatMap((group) => group.fields);

function toForm(company: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(
    FIELDS.map((field) => {
      const value = company[field.key];
      if (value === null || value === undefined) return [field.key, ""];
      return [field.key, field.scale ? String(Number(value) / field.scale) : String(value)];
    }),
  );
}

/** Parametros de calculo laboral que alimentan los reportes. */
export function LaborRulesSettings() {
  const [form, setForm] = useState<Record<string, string> | null>(null);
  const [allowSplitShifts, setAllowSplitShifts] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const company = await api<Record<string, unknown>>("/v1/company");
        setForm(toForm(company));
        setAllowSplitShifts(Boolean(company.allowSplitShifts));
      } catch {
        toast.error("No pudimos cargar las reglas laborales");
      }
    })();
  }, []);

  if (!form) return null;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setIsSaving(true);
    const body: Record<string, unknown> = { allowSplitShifts };
    for (const field of FIELDS) {
      const raw = form[field.key]!.trim();
      if (field.key === "minimumWage") body[field.key] = raw === "" ? null : Number(raw);
      else if (field.kind === "number") body[field.key] = Math.round(Number(raw) * (field.scale ?? 1));
      // El input de hora puede omitir los segundos.
      else if (field.kind === "time") body[field.key] = raw.length === 5 ? `${raw}:00` : raw;
      else body[field.key] = raw.toUpperCase();
    }
    try {
      setForm(toForm(await api<Record<string, unknown>>("/v1/company", { method: "PATCH", body })));
      toast.success("Reglas laborales guardadas");
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : "No se pudo guardar");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Reglas laborales</CardTitle>
        <CardDescription>
          Valores iniciales segun el regimen general privado del Peru. Validalos con tu asesor
          laboral: los reportes se calculan con lo que definas aqui, tambien para fechas pasadas.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="space-y-6">
          {GROUPS.map((group) => (
            <fieldset key={group.title} className="space-y-3">
              <legend className="text-sm font-medium">{group.title}</legend>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {group.fields.map((field) => (
                  <div key={field.key} className="space-y-2">
                    <Label htmlFor={field.key}>{field.label}</Label>
                    <Input
                      id={field.key}
                      type={field.kind}
                      step={field.kind === "number" ? "any" : field.kind === "time" ? 1 : undefined}
                      min={field.kind === "number" ? 0 : undefined}
                      maxLength={field.kind === "text" ? 3 : undefined}
                      required={field.key !== "minimumWage"}
                      value={form[field.key]}
                      onChange={(e) => setForm({ ...form, [field.key]: e.target.value })}
                      className="tabular-nums"
                    />
                  </div>
                ))}
              </div>
            </fieldset>
          ))}
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="font-medium">Permitir turnos partidos</p>
              <p className="mt-0.5 text-sm text-muted-foreground">
                Admite varias entradas y salidas en una misma jornada aunque no haya varios turnos
                asignados.
              </p>
            </div>
            <Switch
              checked={allowSplitShifts}
              onCheckedChange={setAllowSplitShifts}
              aria-label="Permitir turnos partidos"
            />
          </div>
          <Button type="submit" disabled={isSaving}>
            <Save />
            {isSaving ? "Guardando..." : "Guardar reglas"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
