"use client";

import { Check, ExternalLink, Minus } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { ApiError, api } from "../lib/api";
import { cn } from "../lib/utils";
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Tabs,
  TabsList,
  TabsTrigger,
} from "./ui";

export interface Plan {
  tier: string;
  displayName: string;
  tagline: string;
  maxEmployees: number;
  maxBranches: number;
  historyMonths: number;
  monthlyPriceUsd: number;
  yearlyPriceUsd: number;
  features: string[];
}

export const FEATURE_LABELS: Record<string, string> = {
  BASIC_ATTENDANCE: "Marcacion con selfie y geocerca",
  MULTI_BRANCH: "Multiples sucursales",
  OFFLINE_BATCH: "Modo sin conexion",
  ADVANCED_REPORTS: "Nomina en Excel y PDF",
  WEBHOOKS: "Integraciones y notificaciones",
  AUDIT_TRAIL: "Auditoria laboral",
  AUDIT_TRAIL_FULL: "Auditoria completa y sin limite de historial",
  FACE_MATCH: "Verificacion facial",
  CUSTOM_REPORTS: "Informes personalizados",
  API_ACCESS: "Acceso a la API",
};

/** Todas las capacidades del catalogo, en el orden en que aparecen. */
function allFeatures(plans: Plan[]): string[] {
  const seen: string[] = [];
  for (const plan of plans) {
    for (const feature of plan.features) if (!seen.includes(feature)) seen.push(feature);
  }
  return seen;
}

const UNLIMITED = 100_000;

/** `1 sucursal` / `10 sucursales`. Un plural mal puesto se nota en una tarifa. */
function plural(count: number, singular: string, pluralForm: string): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function seatLine(max: number): string {
  return max >= UNLIMITED
    ? "Colaboradores sin limite"
    : `Hasta ${max} ${max === 1 ? "colaborador" : "colaboradores"}`;
}

export function UpgradeDialog({
  open,
  onOpenChange,
  plans,
  currentTier,
  seatsUsed,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  plans: Plan[];
  currentTier: string;
  seatsUsed: number;
}) {
  const [interval, setInterval] = useState<"MONTHLY" | "YEARLY">("MONTHLY");
  const [pending, setPending] = useState<string | null>(null);

  const order = plans.map((plan) => plan.tier);
  const features = allFeatures(plans);

  const startCheckout = async (tier: string) => {
    setPending(tier);
    try {
      const session = await api<{ checkoutUrl: string }>("/v1/billing/checkout-session", {
        method: "POST",
        body: { tier, interval },
      });
      // Redireccion completa: el pago ocurre en el dominio de la pasarela.
      window.location.href = session.checkoutUrl;
    } catch (error) {
      if (error instanceof ApiError && error.code === "EMPLOYEE_LIMIT_REACHED") {
        toast.error("No cabes en ese plan todavia", { description: error.message });
      } else if (error instanceof ApiError && error.code === "PAYMENT_REQUIRED") {
        toast.error("La pasarela de pago no esta configurada", {
          description: "Configura las credenciales de MercadoPago o Stripe en el servidor.",
        });
      } else {
        toast.error(error instanceof ApiError ? error.message : "No se pudo iniciar el pago");
      }
    } finally {
      setPending(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl">
        <DialogHeader>
          <DialogTitle>Planes de Scire 360 Chronos</DialogTitle>
          <DialogDescription>
            Tienes {seatsUsed} colaborador{seatsUsed === 1 ? "" : "es"} activo
            {seatsUsed === 1 ? "" : "s"}. Elige el plan que los cubra.
          </DialogDescription>
        </DialogHeader>

        <Tabs
          value={interval}
          onValueChange={(value) => setInterval(value as "MONTHLY" | "YEARLY")}
          className="mb-5"
        >
          <TabsList>
            <TabsTrigger value="MONTHLY">Mensual</TabsTrigger>
            <TabsTrigger value="YEARLY">
              Anual
              <Badge variant="success" className="ml-1">
                2 meses gratis
              </Badge>
            </TabsTrigger>
          </TabsList>
        </Tabs>

        <div className="grid gap-3 lg:grid-cols-4">
          {plans.map((plan) => {
            const isCurrent = plan.tier === currentTier;
            const price = interval === "YEARLY" ? plan.yearlyPriceUsd : plan.monthlyPriceUsd;
            const tooSmall = plan.maxEmployees < seatsUsed;

            return (
              <div
                key={plan.tier}
                className={cn(
                  "flex flex-col rounded-2xl border p-5",
                  isCurrent ? "border-primary bg-primary/5" : "border-border",
                )}
              >
                <div className="flex items-center gap-2">
                  <h3 className="font-bold">{plan.displayName}</h3>
                  {isCurrent && <Badge variant="info">Actual</Badge>}
                </div>
                <p className="mt-1 min-h-[2.5rem] text-xs text-muted-foreground">{plan.tagline}</p>

                <p className="mt-3 text-3xl font-bold tabular-nums">
                  ${price}
                  <span className="text-sm font-normal text-muted-foreground">/mes</span>
                </p>
                {interval === "YEARLY" && price > 0 && (
                  <p className="text-xs text-muted-foreground tabular-nums">
                    ${price * 12} facturados al ano
                  </p>
                )}

                <p className="mt-3 text-sm font-medium">{seatLine(plan.maxEmployees)}</p>
                <p className="text-xs text-muted-foreground">
                  {plan.maxBranches >= 1000
                    ? "Sucursales ilimitadas"
                    : plural(plan.maxBranches, "sucursal", "sucursales")}
                  {" · "}
                  {plural(plan.historyMonths, "mes", "meses")} de historial
                </p>
                {plan.maxEmployees >= UNLIMITED && (
                  <p className="text-xs text-muted-foreground">Cuota acordada por contrato</p>
                )}

                <div className="mt-auto pt-5">
                  {isCurrent ? (
                    <Button variant="outline" className="w-full" disabled>
                      Tu plan actual
                    </Button>
                  ) : plan.tier === "FREE" ? (
                    <Button variant="ghost" className="w-full" disabled>
                      Sin coste
                    </Button>
                  ) : (
                    <Button
                      className="w-full"
                      disabled={pending !== null || tooSmall}
                      onClick={() => void startCheckout(plan.tier)}
                      title={
                        tooSmall
                          ? `Este plan admite ${plan.maxEmployees} colaboradores y tienes ${seatsUsed}`
                          : undefined
                      }
                    >
                      {pending === plan.tier ? (
                        "Redirigiendo..."
                      ) : tooSmall ? (
                        "No cubre tu equipo"
                      ) : (
                        <>
                          {order.indexOf(plan.tier) > order.indexOf(currentTier)
                            ? "Mejorar plan"
                            : "Cambiar a este plan"}
                          <ExternalLink />
                        </>
                      )}
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* Tabla comparativa: lo que gana o pierde al cambiar. */}
        <div className="mt-6 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border">
                <th className="py-2 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Funcionalidad
                </th>
                {plans.map((plan) => (
                  <th
                    key={plan.tier}
                    className="px-2 py-2 text-center text-xs font-semibold uppercase tracking-wide text-muted-foreground"
                  >
                    {plan.displayName}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {features.map((feature) => (
                <tr key={feature} className="border-b border-border/60">
                  <td className="py-2.5">{FEATURE_LABELS[feature] ?? feature}</td>
                  {plans.map((plan) => (
                    <td key={plan.tier} className="px-2 py-2.5 text-center">
                      {plan.features.includes(feature) ? (
                        <Check
                          className="mx-auto h-4 w-4 text-state-success"
                          aria-label="Incluido"
                        />
                      ) : (
                        <Minus
                          className="mx-auto h-4 w-4 text-muted-foreground/40"
                          aria-label="No incluido"
                        />
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p className="mt-4 text-center text-xs text-muted-foreground">
          El pago se procesa en la pasarela. Puedes cancelar en cualquier momento y el servicio
          sigue activo hasta el final del ciclo pagado.
        </p>
      </DialogContent>
    </Dialog>
  );
}
