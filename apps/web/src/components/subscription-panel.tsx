"use client";

import { AlertTriangle, Check, CreditCard, Receipt, Sparkles, XCircle } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { ApiError, api } from "../lib/api";
import { formatDate, formatMoney } from "../lib/format";
import { FEATURE_LABELS, UpgradeDialog, type Plan } from "./upgrade-dialog";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "./ui";

interface SubscriptionData {
  plan: Plan;
  usage: {
    seatsUsed: number;
    seatsLimit: number;
    seatsPercent: number;
    seatsAvailable: number;
    branchesUsed: number;
    branchesLimit: number;
  };
  subscription: {
    tier: string;
    status: string;
    accountStatus: string;
    interval: string;
    provider: string;
    currentPeriodEnd: string | null;
    trialEndsAt: string | null;
    trialDaysLeft: number | null;
    graceEndsAt: string | null;
    cancelAtPeriodEnd: boolean;
    amountCents: number;
    currency: string;
  };
  account: {
    status: string;
    suspendedAt: string | null;
    graceEndsAt: string | null;
    trialEndingSoon: boolean;
  };
  catalog: Plan[];
  invoices: {
    id: string;
    status: string;
    amountCents: number;
    currency: string;
    issuedAt: string;
    paidAt: string | null;
    failedAt: string | null;
    failureReason: string | null;
    hostedInvoiceUrl: string | null;
  }[];
}

const ACCOUNT_LABELS: Record<string, string> = {
  TRIALING: "Periodo de prueba",
  ACTIVE: "Activa",
  PAST_DUE: "Pago pendiente",
  SUSPENDED: "Suspendida",
};

const INVOICE_VARIANT: Record<string, "success" | "warning" | "danger" | "default"> = {
  PAID: "success",
  PENDING: "warning",
  FAILED: "danger",
  REFUNDED: "default",
  VOID: "default",
};

const INVOICE_LABELS: Record<string, string> = {
  PAID: "Pagada",
  PENDING: "Pendiente",
  FAILED: "Rechazada",
  REFUNDED: "Reembolsada",
  VOID: "Anulada",
  DRAFT: "Borrador",
};

const UNLIMITED = 100_000;

export function SubscriptionPanel() {
  const [data, setData] = useState<SubscriptionData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [upgradeOpen, setUpgradeOpen] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await api<SubscriptionData>("/v1/subscription"));
    } catch {
      toast.error("No pudimos cargar la suscripcion");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();

    // Al volver de la pasarela el webhook puede tardar unos segundos: se
    // recarga una vez para que el panel refleje el pago sin tener que recargar
    // la pagina a mano.
    if (new URLSearchParams(window.location.search).get("checkout") === "done") {
      toast.success("Pago recibido", { description: "Estamos activando tu plan." });
      const timer = setTimeout(() => void load(), 4000);
      return () => clearTimeout(timer);
    }
  }, [load]);

  const cancel = async () => {
    setIsCancelling(true);
    try {
      await api("/v1/billing/cancel", { method: "POST", body: { atPeriodEnd: true } });
      toast.success("Suscripcion cancelada", {
        description: "El servicio sigue activo hasta el final del ciclo pagado.",
      });
      void load();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : "No se pudo cancelar");
    } finally {
      setIsCancelling(false);
    }
  };

  if (isLoading || !data) return <Skeleton className="h-96" />;

  const { plan, usage, subscription, account, catalog, invoices } = data;
  const nearLimit = usage.seatsPercent >= 80;
  const unlimited = usage.seatsLimit >= UNLIMITED;

  return (
    <div className="space-y-6">
      <AccountBanner account={account} subscription={subscription} onUpgrade={() => setUpgradeOpen(true)} />

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <CardTitle className="flex items-center gap-2">
                  Plan {plan.displayName}
                  <Badge
                    variant={
                      account.status === "ACTIVE"
                        ? "success"
                        : account.status === "SUSPENDED"
                          ? "danger"
                          : "warning"
                    }
                  >
                    {ACCOUNT_LABELS[account.status] ?? account.status}
                  </Badge>
                </CardTitle>
                <CardDescription>
                  {plan.monthlyPriceUsd === 0
                    ? "Sin coste"
                    : `${formatMoney(subscription.amountCents || plan.monthlyPriceUsd * 100, subscription.currency)} · ${subscription.interval === "YEARLY" ? "anual" : "mensual"}`}
                  {subscription.currentPeriodEnd &&
                    ` · ${subscription.cancelAtPeriodEnd ? "termina" : "renueva"} el ${formatDate(subscription.currentPeriodEnd)}`}
                </CardDescription>
              </div>
              <Button onClick={() => setUpgradeOpen(true)}>
                <Sparkles />
                Ver planes
              </Button>
            </div>
          </CardHeader>

          <CardContent className="space-y-6">
            <div>
              <div className="flex items-end justify-between">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Colaboradores activos
                  </p>
                  <p className="mt-1 text-3xl font-bold tabular-nums">
                    {usage.seatsUsed}
                    <span className="text-lg font-normal text-muted-foreground">
                      {unlimited ? " · sin limite" : ` / ${usage.seatsLimit}`}
                    </span>
                  </p>
                </div>
                {!unlimited && (
                  <Badge variant={nearLimit ? "warning" : "info"}>{usage.seatsPercent}% del cupo</Badge>
                )}
              </div>

              {!unlimited && (
                <>
                  <div
                    className="mt-3 h-2.5 overflow-hidden rounded-full bg-secondary"
                    role="progressbar"
                    aria-valuenow={usage.seatsPercent}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-label="Consumo del cupo de colaboradores"
                  >
                    <div
                      className={`h-full rounded-full transition-all ${nearLimit ? "bg-state-warning-bg" : "bg-accent"}`}
                      style={{ width: `${Math.max(usage.seatsPercent, 2)}%` }}
                    />
                  </div>
                  {nearLimit && (
                    <p className="mt-2 text-xs text-state-warning">
                      Te quedan {usage.seatsAvailable} asiento
                      {usage.seatsAvailable === 1 ? "" : "s"}. Amplia el plan antes de tu proxima
                      incorporacion.
                    </p>
                  )}
                </>
              )}
            </div>

            <div className="grid gap-4 sm:grid-cols-3">
              <div className="rounded-xl border border-border p-4">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">Sucursales</p>
                <p className="mt-1 text-lg font-bold tabular-nums">
                  {usage.branchesUsed}
                  <span className="text-sm font-normal text-muted-foreground">
                    {" "}
                    / {usage.branchesLimit >= 1000 ? "∞" : usage.branchesLimit}
                  </span>
                </p>
              </div>
              <div className="rounded-xl border border-border p-4">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">Historial</p>
                <p className="mt-1 text-lg font-bold tabular-nums">{plan.historyMonths} meses</p>
              </div>
              <div className="rounded-xl border border-border p-4">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">Pasarela</p>
                <p className="mt-1 text-lg font-bold">
                  {subscription.provider === "STRIPE" ? "Stripe" : "MercadoPago"}
                </p>
              </div>
            </div>

            {account.status !== "SUSPENDED" && !subscription.cancelAtPeriodEnd && plan.tier !== "FREE" && (
              <Button variant="ghost" size="sm" onClick={() => void cancel()} disabled={isCancelling}>
                <XCircle />
                {isCancelling ? "Cancelando..." : "Cancelar suscripcion"}
              </Button>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Incluido en tu plan</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2.5">
              {plan.features.map((feature) => (
                <li key={feature} className="flex items-start gap-2 text-sm">
                  <Check className="mt-0.5 h-4 w-4 shrink-0 text-state-success" />
                  <span>{FEATURE_LABELS[feature] ?? feature}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </div>

      <Card className="overflow-hidden">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <CreditCard className="h-4 w-4" />
            Historial de facturas
          </CardTitle>
        </CardHeader>

        {invoices.length === 0 ? (
          <CardContent className="flex flex-col items-center gap-2 py-10 text-center">
            <Receipt className="h-7 w-7 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              Todavia no hay cobros. Las facturas apareceran aqui al activar un plan de pago.
            </p>
          </CardContent>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Emitida</TableHead>
                <TableHead>Importe</TableHead>
                <TableHead>Estado</TableHead>
                <TableHead>Detalle</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {invoices.map((invoice) => (
                <TableRow key={invoice.id}>
                  <TableCell className="tabular-nums">{formatDate(invoice.issuedAt)}</TableCell>
                  <TableCell className="font-medium tabular-nums">
                    {formatMoney(invoice.amountCents, invoice.currency)}
                  </TableCell>
                  <TableCell>
                    <Badge variant={INVOICE_VARIANT[invoice.status] ?? "default"}>
                      {INVOICE_LABELS[invoice.status] ?? invoice.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {invoice.paidAt
                      ? `Pagada el ${formatDate(invoice.paidAt)}`
                      : (invoice.failureReason ?? "—")}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      <UpgradeDialog
        open={upgradeOpen}
        onOpenChange={setUpgradeOpen}
        plans={catalog}
        currentTier={plan.tier}
        seatsUsed={usage.seatsUsed}
      />
    </div>
  );
}

/**
 * Banner de estado de la cuenta.
 *
 * Solo aparece cuando hay algo que hacer. Un aviso permanente se convierte en
 * decorado y deja de leerse justo cuando importa.
 */
function AccountBanner({
  account,
  subscription,
  onUpgrade,
}: {
  account: SubscriptionData["account"];
  subscription: SubscriptionData["subscription"];
  onUpgrade: () => void;
}) {
  if (account.status === "SUSPENDED") {
    return (
      <div
        role="alert"
        className="flex flex-wrap items-start gap-3 rounded-2xl border border-state-danger-bg/25 bg-state-danger-bg/10 p-4"
      >
        <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-state-danger" />
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-state-danger">Cuenta suspendida</p>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Tus colaboradores no pueden marcar asistencia. Activa un plan para reactivar el
            servicio de inmediato.
          </p>
        </div>
        <Button onClick={onUpgrade}>Reactivar</Button>
      </div>
    );
  }

  if (account.status === "PAST_DUE") {
    const days = account.graceEndsAt
      ? Math.max(0, Math.ceil((new Date(account.graceEndsAt).getTime() - Date.now()) / 86_400_000))
      : null;
    return (
      <div
        role="alert"
        className="flex flex-wrap items-start gap-3 rounded-2xl border border-state-warning-bg/25 bg-state-warning-bg/10 p-4"
      >
        <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-state-warning" />
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-state-warning">
            No pudimos procesar tu ultimo pago
          </p>
          <p className="mt-0.5 text-sm text-muted-foreground">
            El servicio sigue funcionando
            {days !== null ? ` ${days} dia${days === 1 ? "" : "s"} mas` : ""}. Actualiza tu metodo
            de pago para no interrumpir la marcacion de tu equipo.
          </p>
        </div>
        <Button onClick={onUpgrade}>Regularizar</Button>
      </div>
    );
  }

  if (account.trialEndingSoon) {
    return (
      <div
        role="status"
        className="flex flex-wrap items-start gap-3 rounded-2xl border border-state-warning-bg/25 bg-state-warning-bg/10 p-4"
      >
        <Sparkles className="mt-0.5 h-5 w-5 shrink-0 text-state-warning" />
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-state-warning">
            {subscription.trialDaysLeft === 0
              ? "Tu prueba gratuita termina hoy"
              : `Quedan ${subscription.trialDaysLeft} dias de prueba`}
          </p>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Activa un plan antes de que finalice para no interrumpir la marcacion de tu equipo.
          </p>
        </div>
        <Button onClick={onUpgrade}>Elegir plan</Button>
      </div>
    );
  }

  return null;
}
