"use client";

import { Check, Copy, Fingerprint, Plus } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { ApiError, api } from "../lib/api";
import { formatDateTime } from "../lib/format";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui";

interface Device {
  id: string;
  name: string;
  serialNumber: string | null;
  tokenPrefix: string;
  isActive: boolean;
  lastSeenAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  branch: { id: string; name: string } | null;
}

/** Valor centinela del selector: Radix Select no admite value="". */
const NO_BRANCH = "__none__";

function NewDeviceDialog({ onCreated }: { onCreated: () => void }) {
  const { branches } = useBranch();
  const [open, setOpen] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [form, setForm] = useState({ name: "", serialNumber: "", branchId: NO_BRANCH });
  const [token, setToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const close = (value: boolean) => {
    setOpen(value);
    if (!value) {
      // El token no debe quedarse en memoria al reabrir el dialogo.
      setToken(null);
      setCopied(false);
      setForm({ name: "", serialNumber: "", branchId: NO_BRANCH });
    }
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setIsSaving(true);
    try {
      const result = await api<{ device: Device; token: string }>("/v1/biometric/devices", {
        method: "POST",
        body: {
          name: form.name.trim(),
          ...(form.serialNumber.trim() ? { serialNumber: form.serialNumber.trim() } : {}),
          ...(form.branchId !== NO_BRANCH ? { branchId: form.branchId } : {}),
        },
      });
      setToken(result.token);
      onCreated();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : "No se pudo registrar el reloj");
    } finally {
      setIsSaving(false);
    }
  };

  const copy = async () => {
    if (!token) return;
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
    } catch {
      toast.error("No se pudo copiar al portapapeles");
    }
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <Button size="sm" onClick={() => setOpen(true)}>
        <Plus />
        Registrar reloj
      </Button>
      <DialogContent className="max-w-lg">
        {token ? (
          <>
            <DialogHeader>
              <DialogTitle>Token del reloj</DialogTitle>
              <DialogDescription>
                Configuralo en el reloj o en su conector como cabecera <code>X-Device-Key</code>.
                No se volvera a mostrar: si se pierde, revoca el reloj y registra uno nuevo.
              </DialogDescription>
            </DialogHeader>
            <p className="break-all rounded-xl border border-border bg-secondary/50 p-4 font-mono text-sm">
              {token}
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => void copy()}>
                {copied ? <Check /> : <Copy />}
                {copied ? "Copiado" : "Copiar"}
              </Button>
              <Button onClick={() => close(false)}>Listo</Button>
            </div>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Registrar reloj biometrico</DialogTitle>
              <DialogDescription>
                Se generara un token para que el reloj envie sus marcaciones a esta empresa.
              </DialogDescription>
            </DialogHeader>
            <form onSubmit={submit} className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="deviceName">Nombre</Label>
                  <Input
                    id="deviceName"
                    required
                    minLength={2}
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    placeholder="Reloj recepcion"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="deviceSerial">N.º de serie (opcional)</Label>
                  <Input
                    id="deviceSerial"
                    value={form.serialNumber}
                    onChange={(e) => setForm({ ...form, serialNumber: e.target.value })}
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="deviceBranch">Sucursal</Label>
                <Select value={form.branchId} onValueChange={(branchId) => setForm({ ...form, branchId })}>
                  <SelectTrigger id="deviceBranch">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_BRANCH}>Sin asignar (cada marcacion indica la suya)</SelectItem>
                    {branches.map((branch) => (
                      <SelectItem key={branch.id} value={branch.id}>
                        {branch.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex justify-end gap-2">
                <Button type="button" variant="outline" onClick={() => close(false)}>
                  Cancelar
                </Button>
                <Button type="submit" disabled={isSaving}>
                  {isSaving ? "Registrando..." : "Registrar"}
                </Button>
              </div>
            </form>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function BiometricDevices() {
  const [devices, setDevices] = useState<Device[]>([]);

  const load = useCallback(async () => {
    try {
      setDevices(await api<Device[]>("/v1/biometric/devices"));
    } catch {
      toast.error("No pudimos cargar los relojes biometricos");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const revoke = async (device: Device) => {
    if (!window.confirm(`¿Revocar "${device.name}"? Dejara de poder enviar marcaciones.`)) return;
    try {
      await api(`/v1/biometric/devices/${device.id}/revoke`, { method: "POST" });
      toast.success(`${device.name} revocado`);
      void load();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : "No se pudo revocar");
    }
  };

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <div>
          <CardTitle>Relojes biometricos</CardTitle>
          <CardDescription>
            Equipos de huella, rostro o tarjeta que envian marcaciones por codigo de empleado.
          </CardDescription>
        </div>
        <NewDeviceDialog onCreated={load} />
      </CardHeader>
      <CardContent className="space-y-2">
        {devices.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-10 text-center">
            <Fingerprint className="h-7 w-7 text-muted-foreground" />
            <p className="font-medium">Ningun reloj registrado</p>
            <p className="max-w-sm text-sm text-muted-foreground">
              Registra un reloj para obtener su token de conexion.
            </p>
          </div>
        ) : (
          devices.map((device) => (
            <div
              key={device.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border p-4"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <p className="font-medium">{device.name}</p>
                  {device.revokedAt ? (
                    <Badge variant="danger">Revocado</Badge>
                  ) : (
                    <Badge variant="success">Activo</Badge>
                  )}
                </div>
                <p className="mt-0.5 text-sm text-muted-foreground">
                  {device.branch?.name ?? "Sin sucursal asignada"}
                  {device.serialNumber ? ` · S/N ${device.serialNumber}` : ""}
                </p>
                <p className="mt-1 font-mono text-xs text-muted-foreground">
                  {device.tokenPrefix}… · ultima conexion{" "}
                  {device.lastSeenAt ? formatDateTime(device.lastSeenAt) : "nunca"}
                </p>
              </div>
              {!device.revokedAt && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-state-danger"
                  onClick={() => void revoke(device)}
                >
                  Revocar
                </Button>
              )}
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}
