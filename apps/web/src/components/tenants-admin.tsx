"use client";

import {
  PLAN_LIMITS,
  TIER_ORDER,
  UNLIMITED_SEATS,
  type AccountStatus,
  type SubscriptionTier,
} from "@scire/shared";
import { Building2, Check, Copy, Plus, Search } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { ApiError, api, qs } from "../lib/api";
import { formatDate } from "../lib/format";
import { EmptySearchArt, EmptyState } from "./empty-state";
import { Motion } from "./motion";
import {
  Badge,
  Button,
  Card,
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
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "./ui";

interface Tenant {
  id: string;
  name: string;
  slug: string;
  taxId: string | null;
  tier: SubscriptionTier;
  maxEmployees: number;
  accountStatus: AccountStatus;
  suspendedAt: string | null;
  graceEndsAt: string | null;
  createdAt: string;
  admin: { id: string; fullName: string; email: string; lastLoginAt: string | null } | null;
  seatsUsed: number;
  branchesActive: number;
  hasExternalBilling: boolean;
}

interface TenantList {
  items: Tenant[];
  total: number;
  page: number;
  totalPages: number;
  totals: Record<AccountStatus, number>;
}

const ACCOUNT_LABELS: Record<AccountStatus, string> = {
  ACTIVE: "Activa",
  TRIALING: "En prueba",
  PAST_DUE: "Pago pendiente",
  SUSPENDED: "Suspendida",
};

const ACCOUNT_VARIANT: Record<AccountStatus, "success" | "info" | "warning" | "danger"> = {
  ACTIVE: "success",
  TRIALING: "info",
  PAST_DUE: "warning",
  SUSPENDED: "danger",
};

const TIER_VARIANT: Record<SubscriptionTier, "default" | "info" | "violet" | "success"> = {
  FREE: "default",
  STARTER: "info",
  BUSINESS: "success",
  ENTERPRISE: "violet",
};

const textareaClass =
  "flex min-h-[88px] w-full rounded-xl border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

function seatsLabel(used: number, max: number): string {
  return `${used} / ${max >= UNLIMITED_SEATS ? "∞" : max}`;
}

// --- Alta de empresa ----------------------------------------------------------

const EMPTY_FORM = {
  companyName: "",
  taxId: "",
  timezone: "America/Lima",
  tier: "STARTER" as SubscriptionTier,
  adminFullName: "",
  adminEmail: "",
  adminPassword: "",
};

function CreateTenantDialog({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  /** Credenciales a mostrar UNA vez tras el alta. */
  const [credentials, setCredentials] = useState<{ email: string; password: string } | null>(
    null,
  );
  const [copied, setCopied] = useState(false);

  const close = (value: boolean) => {
    setOpen(value);
    if (!value) {
      // Al cerrar se descarta la contrasena de memoria: no debe sobrevivir a
      // que el operador abra el dialogo para el siguiente cliente.
      setCredentials(null);
      setCopied(false);
      setFieldErrors({});
    }
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setIsSaving(true);
    setFieldErrors({});
    try {
      const result = await api<{ tenant: Tenant; temporaryPassword: string | null }>(
        "/v1/platform/tenants",
        {
          method: "POST",
          body: {
            companyName: form.companyName.trim(),
            tier: form.tier,
            timezone: form.timezone.trim() || "America/Lima",
            adminFullName: form.adminFullName.trim(),
            adminEmail: form.adminEmail.trim(),
            ...(form.taxId.trim() ? { taxId: form.taxId.trim() } : {}),
            ...(form.adminPassword ? { adminPassword: form.adminPassword } : {}),
          },
        },
      );

      toast.success(`${result.tenant.name} creada en plan ${PLAN_LIMITS[form.tier].displayName}`);
      onCreated();

      if (result.temporaryPassword) {
        setCredentials({ email: form.adminEmail.trim(), password: result.temporaryPassword });
      } else {
        close(false);
      }
      setForm(EMPTY_FORM);
    } catch (error) {
      if (error instanceof ApiError && error.details) {
        setFieldErrors(error.details as Record<string, string[]>);
      }
      toast.error(error instanceof ApiError ? error.message : "No se pudo crear la empresa");
    } finally {
      setIsSaving(false);
    }
  };

  const copy = async () => {
    if (!credentials) return;
    try {
      await navigator.clipboard.writeText(
        `Usuario: ${credentials.email}\nContrasena temporal: ${credentials.password}`,
      );
      setCopied(true);
    } catch {
      toast.error("No se pudo copiar al portapapeles");
    }
  };

  const errorFor = (field: string) =>
    fieldErrors[field]?.[0] ? (
      <p className="text-xs text-state-danger">{fieldErrors[field]![0]}</p>
    ) : null;

  return (
    <Dialog open={open} onOpenChange={close}>
      <Button onClick={() => setOpen(true)}>
        <Plus />
        Crear Empresa
      </Button>

      <DialogContent className="max-w-lg">
        {credentials ? (
          <>
            <DialogHeader>
              <DialogTitle>Empresa creada</DialogTitle>
              <DialogDescription>
                Entrega estas credenciales al administrador. La contrasena no se volvera a
                mostrar; podra cambiarla desde su perfil.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-2 rounded-xl border border-border bg-secondary/50 p-4 font-mono text-sm">
              <p>
                <span className="text-muted-foreground">Usuario </span>
                {credentials.email}
              </p>
              <p className="break-all">
                <span className="text-muted-foreground">Contrasena </span>
                {credentials.password}
              </p>
            </div>
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
              <DialogTitle>Crear empresa</DialogTitle>
              <DialogDescription>
                Da de alta un cliente con su plan y su administrador inicial. La cuenta nace
                activa y no depende de la pasarela de pago.
              </DialogDescription>
            </DialogHeader>

            <form onSubmit={submit} className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="companyName">Razon social</Label>
                  <Input
                    id="companyName"
                    required
                    minLength={2}
                    value={form.companyName}
                    onChange={(e) => setForm({ ...form, companyName: e.target.value })}
                  />
                  {errorFor("companyName")}
                </div>
                <div className="space-y-2">
                  <Label htmlFor="taxId">RUC / NIT (opcional)</Label>
                  <Input
                    id="taxId"
                    value={form.taxId}
                    onChange={(e) => setForm({ ...form, taxId: e.target.value })}
                  />
                  {errorFor("taxId")}
                </div>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="tier">Plan</Label>
                  <Select
                    value={form.tier}
                    onValueChange={(tier) => setForm({ ...form, tier: tier as SubscriptionTier })}
                  >
                    <SelectTrigger id="tier">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {TIER_ORDER.map((tier) => {
                        const plan = PLAN_LIMITS[tier];
                        return (
                          <SelectItem key={tier} value={tier}>
                            {plan.displayName} ·{" "}
                            {plan.maxEmployees >= UNLIMITED_SEATS
                              ? "ilimitado"
                              : `${plan.maxEmployees} usuarios`}
                          </SelectItem>
                        );
                      })}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="timezone">Zona horaria</Label>
                  <Input
                    id="timezone"
                    value={form.timezone}
                    onChange={(e) => setForm({ ...form, timezone: e.target.value })}
                    placeholder="America/Lima"
                  />
                  {errorFor("timezone")}
                </div>
              </div>
              <p className="-mt-2 text-xs text-muted-foreground">{PLAN_LIMITS[form.tier].tagline}</p>

              <div className="space-y-4 border-t border-border pt-4">
                <p className="text-sm font-semibold">Administrador inicial</p>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="adminFullName">Nombre completo</Label>
                    <Input
                      id="adminFullName"
                      required
                      minLength={2}
                      value={form.adminFullName}
                      onChange={(e) => setForm({ ...form, adminFullName: e.target.value })}
                    />
                    {errorFor("adminFullName")}
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="adminEmail">Correo</Label>
                    <Input
                      id="adminEmail"
                      type="email"
                      required
                      value={form.adminEmail}
                      onChange={(e) => setForm({ ...form, adminEmail: e.target.value })}
                    />
                    {errorFor("adminEmail")}
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="adminPassword">Contrasena (opcional)</Label>
                  <Input
                    id="adminPassword"
                    type="password"
                    autoComplete="new-password"
                    value={form.adminPassword}
                    onChange={(e) => setForm({ ...form, adminPassword: e.target.value })}
                    placeholder="Dejala vacia para generar una temporal"
                  />
                  {errorFor("adminPassword")}
                </div>
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <Button type="button" variant="outline" onClick={() => close(false)}>
                  Cancelar
                </Button>
                <Button type="submit" disabled={isSaving}>
                  {isSaving ? "Creando..." : "Crear empresa"}
                </Button>
              </div>
            </form>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

// --- Suspender / reactivar ----------------------------------------------------

function StatusDialog({
  tenant,
  onClose,
  onDone,
}: {
  tenant: Tenant | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [reason, setReason] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const suspending = tenant?.accountStatus !== "SUSPENDED";

  useEffect(() => setReason(""), [tenant?.id]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!tenant) return;
    setIsSaving(true);
    try {
      await api(`/v1/platform/tenants/${tenant.id}/status`, {
        method: "PATCH",
        body: { status: suspending ? "SUSPENDED" : "ACTIVE", reason: reason.trim() },
      });
      toast.success(`${tenant.name}: ${suspending ? "suspendida" : "reactivada"}`, {
        description: suspending
          ? "Se cerraron todas sus sesiones y el cambio quedo en auditoria."
          : "Sus usuarios ya pueden volver a entrar.",
      });
      onClose();
      onDone();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : "No se pudo actualizar la empresa");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Dialog open={tenant !== null} onOpenChange={(value) => !value && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{suspending ? "Suspender empresa" : "Reactivar empresa"}</DialogTitle>
          <DialogDescription>
            {suspending
              ? `${tenant?.name} perdera el acceso de inmediato: se cerraran las sesiones de todos sus usuarios y nadie podra marcar asistencia.`
              : `${tenant?.name} recuperara el acceso con su plan actual. Si estaba en prueba o con pago pendiente, deja de tener fecha de vencimiento.`}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="reason">Motivo</Label>
            <textarea
              id="reason"
              required
              minLength={3}
              maxLength={500}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className={textareaClass}
              placeholder={
                suspending ? "Ej. Impago de la factura de septiembre" : "Ej. Pago recibido por transferencia"
              }
            />
            <p className="text-xs text-muted-foreground">Queda registrado en la auditoria de la empresa.</p>
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancelar
            </Button>
            <Button
              type="submit"
              variant={suspending ? "destructive" : "default"}
              disabled={isSaving || reason.trim().length < 3}
            >
              {isSaving ? "Guardando..." : suspending ? "Suspender" : "Reactivar"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// --- Consola ------------------------------------------------------------------

export function TenantsAdmin({ ownCompanyId }: { ownCompanyId: string }) {
  const [data, setData] = useState<TenantList | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [tier, setTier] = useState("");
  const [page, setPage] = useState(1);
  const [target, setTarget] = useState<Tenant | null>(null);

  const load = useCallback(async () => {
    setIsLoading(true);
    try {
      setData(
        await api<TenantList>(
          `/v1/platform/tenants${qs({ page, pageSize: 25, search, status, tier })}`,
        ),
      );
    } catch {
      toast.error("No pudimos cargar las empresas");
    } finally {
      setIsLoading(false);
    }
  }, [page, search, status, tier]);

  // Debounce de la busqueda, igual que en el listado de empleados.
  useEffect(() => {
    const timer = setTimeout(() => void load(), 300);
    return () => clearTimeout(timer);
  }, [load]);

  const filtered = Boolean(search || status || tier);

  return (
    <div className="space-y-4">
      {data && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {(["ACTIVE", "TRIALING", "PAST_DUE", "SUSPENDED"] as const).map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => {
                setStatus(status === key ? "" : key);
                setPage(1);
              }}
              aria-pressed={status === key}
              className="text-left"
            >
              <Card
                className={
                  status === key ? "border-primary p-4" : "p-4 transition-colors hover:bg-secondary/40"
                }
              >
                <p className="text-xs font-medium text-muted-foreground">{ACCOUNT_LABELS[key]}</p>
                <p className="mt-1 text-2xl font-bold tabular-nums">{data.totals[key]}</p>
              </Card>
            </button>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[240px] flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            placeholder="Buscar por nombre, slug o RUC"
            className="pl-9"
            aria-label="Buscar empresa"
          />
        </div>

        <Select
          value={status || "ALL"}
          onValueChange={(value) => {
            setStatus(value === "ALL" ? "" : value);
            setPage(1);
          }}
        >
          <SelectTrigger className="w-44" aria-label="Filtrar por estado">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">Todos los estados</SelectItem>
            {Object.entries(ACCOUNT_LABELS).map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select
          value={tier || "ALL"}
          onValueChange={(value) => {
            setTier(value === "ALL" ? "" : value);
            setPage(1);
          }}
        >
          <SelectTrigger className="w-40" aria-label="Filtrar por plan">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">Todos los planes</SelectItem>
            {TIER_ORDER.map((value) => (
              <SelectItem key={value} value={value}>
                {PLAN_LIMITS[value].displayName}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <CreateTenantDialog onCreated={load} />
      </div>

      {isLoading && !data ? (
        <div className="space-y-2">
          {Array.from({ length: 6 }).map((_, index) => (
            <Skeleton key={index} className="h-14" />
          ))}
        </div>
      ) : !data || data.items.length === 0 ? (
        <Motion>
          <Card>
            <EmptyState
              art={<EmptySearchArt />}
              title={filtered ? "Ninguna empresa coincide con los filtros" : "Todavia no hay empresas"}
              description={
                filtered
                  ? "Prueba con otro nombre o quita los filtros activos."
                  : "Crea la primera empresa cliente con el boton Crear Empresa."
              }
            />
          </Card>
        </Motion>
      ) : (
        <>
          <Card className="overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Empresa</TableHead>
                  <TableHead>Plan</TableHead>
                  <TableHead>Estado</TableHead>
                  <TableHead>Administrador</TableHead>
                  <TableHead>Usuarios</TableHead>
                  <TableHead>Alta</TableHead>
                  <TableHead className="text-right">Acciones</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.items.map((tenant) => {
                  const isOwn = tenant.id === ownCompanyId;
                  return (
                    <TableRow key={tenant.id}>
                      <TableCell>
                        <p className="flex items-center gap-1.5 font-medium">
                          {tenant.name}
                          {isOwn && (
                            <span className="text-xs font-normal text-muted-foreground">(tu empresa)</span>
                          )}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {tenant.slug}
                          {tenant.taxId ? ` · ${tenant.taxId}` : ""}
                        </p>
                      </TableCell>
                      <TableCell>
                        <Badge variant={TIER_VARIANT[tenant.tier]}>
                          {PLAN_LIMITS[tenant.tier].displayName}
                        </Badge>
                        <p className="mt-1 text-[11px] text-muted-foreground">
                          {tenant.hasExternalBilling ? "Pasarela" : "Manual"}
                        </p>
                      </TableCell>
                      <TableCell>
                        <Badge variant={ACCOUNT_VARIANT[tenant.accountStatus]}>
                          {ACCOUNT_LABELS[tenant.accountStatus]}
                        </Badge>
                        {tenant.accountStatus === "SUSPENDED" && tenant.suspendedAt && (
                          <p className="mt-1 text-[11px] text-muted-foreground">
                            desde {formatDate(tenant.suspendedAt)}
                          </p>
                        )}
                        {tenant.accountStatus !== "SUSPENDED" && tenant.graceEndsAt && (
                          <p className="mt-1 text-[11px] text-muted-foreground">
                            vence {formatDate(tenant.graceEndsAt)}
                          </p>
                        )}
                      </TableCell>
                      <TableCell>
                        {tenant.admin ? (
                          <>
                            <p className="text-sm">{tenant.admin.fullName}</p>
                            <p className="text-xs text-muted-foreground">{tenant.admin.email}</p>
                          </>
                        ) : (
                          <span className="text-xs text-muted-foreground">Sin administrador</span>
                        )}
                      </TableCell>
                      <TableCell className="tabular-nums text-muted-foreground">
                        {seatsLabel(tenant.seatsUsed, tenant.maxEmployees)}
                      </TableCell>
                      <TableCell className="tabular-nums text-muted-foreground">
                        {formatDate(tenant.createdAt)}
                      </TableCell>
                      <TableCell className="text-right">
                        {tenant.accountStatus === "SUSPENDED" ? (
                          <Button variant="outline" size="sm" onClick={() => setTarget(tenant)}>
                            Reactivar
                          </Button>
                        ) : (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-state-danger"
                            disabled={isOwn}
                            title={isOwn ? "No puedes suspender tu propia empresa" : undefined}
                            onClick={() => setTarget(tenant)}
                          >
                            Suspender
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </Card>

          <div className="flex items-center justify-between text-sm text-muted-foreground">
            <span className="inline-flex items-center gap-1.5">
              <Building2 className="h-3.5 w-3.5" />
              {data.total} empresa{data.total === 1 ? "" : "s"}
            </span>
            {data.totalPages > 1 && (
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page <= 1}
                  onClick={() => setPage((value) => value - 1)}
                >
                  Anterior
                </Button>
                <span className="tabular-nums">
                  {data.page} / {data.totalPages}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page >= data.totalPages}
                  onClick={() => setPage((value) => value + 1)}
                >
                  Siguiente
                </Button>
              </div>
            )}
          </div>
        </>
      )}

      <StatusDialog tenant={target} onClose={() => setTarget(null)} onDone={load} />
    </div>
  );
}
