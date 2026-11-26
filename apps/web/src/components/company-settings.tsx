"use client";

import { Building2, MapPin, Plus, Save, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { ApiError, api } from "../lib/api";
import { BiometricDevices } from "./biometric-devices";
import { useBranch } from "./branch-context";
import { LaborRulesSettings } from "./labor-rules";
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
  Switch,
} from "./ui";

interface Company {
  name: string;
  taxId: string | null;
  timezone: string;
  requireSelfie: boolean;
  requireGeofence: boolean;
  faceMatchEnabled: boolean;
  tier: string;
}

/**
 * Alta de sucursal con geocerca.
 *
 * Tambien es el paso clave del onboarding: una empresa nueva no puede recibir
 * marcaciones hasta que define donde esta su centro de trabajo y con que radio.
 */
function NewBranchDialog({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [form, setForm] = useState({
    name: "",
    address: "",
    latitude: "",
    longitude: "",
    radiusMeters: "100",
  });

  const useCurrentPosition = () => {
    if (!navigator.geolocation) {
      toast.error("Tu navegador no permite obtener la ubicacion");
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setForm((current) => ({
          ...current,
          latitude: position.coords.latitude.toFixed(6),
          longitude: position.coords.longitude.toFixed(6),
        }));
        toast.success("Ubicacion capturada");
      },
      () => toast.error("No pudimos obtener tu ubicacion"),
    );
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setIsSaving(true);
    try {
      await api("/v1/company/branches", {
        method: "POST",
        body: {
          name: form.name.trim(),
          ...(form.address ? { address: form.address.trim() } : {}),
          latitude: Number(form.latitude),
          longitude: Number(form.longitude),
          radiusMeters: Number(form.radiusMeters),
        },
      });
      toast.success(`Sucursal "${form.name}" creada`, {
        description: `Geocerca de ${form.radiusMeters} m alrededor de las coordenadas indicadas.`,
      });
      setOpen(false);
      setForm({ name: "", address: "", latitude: "", longitude: "", radiusMeters: "100" });
      onCreated();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : "No se pudo crear la sucursal");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button onClick={() => setOpen(true)} size="sm">
        <Plus />
        Nueva sucursal
      </Button>

      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Nueva sucursal</DialogTitle>
          <DialogDescription>
            La geocerca define desde donde se puede marcar asistencia.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="branchName">Nombre</Label>
            <Input
              id="branchName"
              required
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="Sede Central"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="address">Direccion</Label>
            <Input
              id="address"
              value={form.address}
              onChange={(e) => setForm({ ...form, address: e.target.value })}
              placeholder="Jr. de la Union 1050, Lima"
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="lat">Latitud</Label>
              <Input
                id="lat"
                required
                type="number"
                step="any"
                min={-90}
                max={90}
                value={form.latitude}
                onChange={(e) => setForm({ ...form, latitude: e.target.value })}
                className="tabular-nums"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="lng">Longitud</Label>
              <Input
                id="lng"
                required
                type="number"
                step="any"
                min={-180}
                max={180}
                value={form.longitude}
                onChange={(e) => setForm({ ...form, longitude: e.target.value })}
                className="tabular-nums"
              />
            </div>
          </div>

          <Button type="button" variant="outline" size="sm" onClick={useCurrentPosition}>
            <MapPin />
            Usar mi ubicacion actual
          </Button>

          <div className="space-y-2">
            <Label htmlFor="radius">Radio de la geocerca (metros)</Label>
            <Input
              id="radius"
              required
              type="number"
              min={20}
              max={5000}
              value={form.radiusMeters}
              onChange={(e) => setForm({ ...form, radiusMeters: e.target.value })}
              className="tabular-nums"
            />
            <p className="text-xs text-muted-foreground">
              Minimo 20 m. Por debajo, el ruido del GPS urbano produce rechazos constantes a
              empleados que si estan en el sitio.
            </p>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancelar
            </Button>
            <Button type="submit" disabled={isSaving}>
              {isSaving ? "Creando..." : "Crear sucursal"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function CompanySettings() {
  const { branches, reload } = useBranch();
  const [company, setCompany] = useState<Company | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    void (async () => {
      try {
        setCompany(await api<Company>("/v1/company"));
      } catch {
        toast.error("No pudimos cargar la configuracion");
      } finally {
        setIsLoading(false);
      }
    })();
  }, []);

  const toggle = async (field: keyof Company, value: boolean) => {
    const previous = company;
    // Actualizacion optimista: el interruptor responde al instante y se
    // revierte si el servidor rechaza el cambio.
    setCompany((current) => (current ? { ...current, [field]: value } : current));
    try {
      const updated = await api<Company>("/v1/company", {
        method: "PATCH",
        body: { [field]: value },
      });
      setCompany(updated);
      toast.success("Configuracion actualizada");
    } catch (error) {
      setCompany(previous);
      toast.error(error instanceof ApiError ? error.message : "No se pudo guardar");
    }
  };

  if (isLoading || !company) return <Skeleton className="h-96" />;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Reglas de marcacion</CardTitle>
          <CardDescription>
            Se aplican a toda la empresa en el momento de registrar una marcacion.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-1">
          {[
            {
              field: "requireSelfie" as const,
              title: "Exigir selfie",
              description:
                "Sin foto no se registra la marcacion. Desactivalo solo para kioscos o puestos sin camara.",
              value: company.requireSelfie,
              disabled: false,
            },
            {
              field: "requireGeofence" as const,
              title: "Exigir geocerca",
              description:
                "Rechaza las marcaciones fuera del area de la sucursal. Desactivalo para personal de campo.",
              value: company.requireGeofence,
              disabled: false,
            },
            {
              field: "faceMatchEnabled" as const,
              title: "Verificacion facial",
              description:
                company.tier === "ENTERPRISE"
                  ? "Compara la selfie contra la foto de perfil oficial del colaborador."
                  : "Requiere el plan Enterprise.",
              value: company.faceMatchEnabled,
              disabled: company.tier !== "ENTERPRISE",
            },
          ].map((setting) => (
            <div
              key={setting.field}
              className="flex items-start justify-between gap-4 border-b border-border py-4 last:border-0"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <p className="font-medium">{setting.title}</p>
                  {setting.disabled && <Badge variant="info">Enterprise</Badge>}
                </div>
                <p className="mt-0.5 text-sm text-muted-foreground">{setting.description}</p>
              </div>
              <Switch
                checked={setting.value}
                disabled={setting.disabled}
                onCheckedChange={(value) => void toggle(setting.field, value)}
                aria-label={setting.title}
              />
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <div>
            <CardTitle>Sucursales y geocercas</CardTitle>
            <CardDescription>
              Cada sucursal define el area desde la que sus colaboradores pueden marcar.
            </CardDescription>
          </div>
          <NewBranchDialog onCreated={reload} />
        </CardHeader>
        <CardContent className="space-y-2">
          {branches.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-10 text-center">
              <Building2 className="h-7 w-7 text-muted-foreground" />
              <p className="font-medium">Todavia no hay sucursales</p>
              <p className="max-w-sm text-sm text-muted-foreground">
                Crea la primera para que tus colaboradores puedan empezar a marcar asistencia.
              </p>
            </div>
          ) : (
            branches.map((branch) => (
              <div
                key={branch.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border p-4"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="font-medium">{branch.name}</p>
                    {!branch.isActive && <Badge variant="default">Inactiva</Badge>}
                  </div>
                  <p className="mt-0.5 text-sm text-muted-foreground">
                    {branch.address ?? "Sin direccion"}
                  </p>
                  <p className="mt-1 text-xs tabular-nums text-muted-foreground">
                    {branch.latitude.toFixed(5)}, {branch.longitude.toFixed(5)} · radio{" "}
                    {branch.radiusMeters} m
                  </p>
                </div>
                <Badge variant="info">
                  {branch.employeeCount} colaborador{branch.employeeCount === 1 ? "" : "es"}
                </Badge>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <LaborRulesSettings />

      <BiometricDevices />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-accent" />
            Datos de la empresa
          </CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-4 sm:grid-cols-3">
            <div>
              <dt className="text-xs uppercase tracking-wide text-muted-foreground">Razon social</dt>
              <dd className="mt-0.5 font-medium">{company.name}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                Identificador fiscal
              </dt>
              <dd className="mt-0.5 font-medium tabular-nums">{company.taxId ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-muted-foreground">Zona horaria</dt>
              <dd className="mt-0.5 font-medium">{company.timezone}</dd>
            </div>
          </dl>
        </CardContent>
      </Card>
    </div>
  );
}
