import { z } from "zod";
import { BillingInterval, PaymentProvider, SubscriptionTier } from "../enums.js";

/**
 * Contratos de facturacion.
 *
 * `FREE` no aparece como destino de checkout a proposito: bajar a gratuito no
 * es un cobro, es una cancelacion, y tiene su propio endpoint.
 */
export const payableTierSchema = z.enum([
  SubscriptionTier.STARTER,
  SubscriptionTier.BUSINESS,
  SubscriptionTier.ENTERPRISE,
]);

export const createCheckoutSchema = z.object({
  tier: payableTierSchema,
  interval: z.nativeEnum(BillingInterval).default(BillingInterval.MONTHLY),
  /** Permite forzar una pasarela concreta; si no, manda BILLING_PROVIDER. */
  provider: z.nativeEnum(PaymentProvider).optional(),
});
export type CreateCheckoutInput = z.infer<typeof createCheckoutSchema>;

export interface CheckoutSession {
  /** URL a la que se redirige al usuario para pagar. */
  checkoutUrl: string;
  provider: PaymentProvider;
  tier: SubscriptionTier;
  interval: BillingInterval;
  /** Importe del ciclo completo, en centavos. */
  amountCents: number;
  currency: string;
  /** Referencia externa que la pasarela devolvera en el webhook. */
  externalReference: string;
  expiresAt: string | null;
}

export const cancelSubscriptionSchema = z.object({
  /**
   * `true` mantiene el servicio hasta el final del ciclo pagado.
   * `false` suspende de inmediato — solo para bajas solicitadas por soporte.
   */
  atPeriodEnd: z.boolean().default(true),
  reason: z.string().trim().max(500).optional(),
});
export type CancelSubscriptionInput = z.infer<typeof cancelSubscriptionSchema>;

/**
 * Eventos normalizados de facturacion.
 *
 * Cada pasarela usa su propio vocabulario (`payment.created`,
 * `preapproval.updated`, `invoice.payment_failed`...). El adaptador los traduce
 * a estos cuatro casos, de modo que la logica de negocio no sabe con quien
 * esta hablando y anadir una tercera pasarela no toca el nucleo.
 */
export const BillingEventType = {
  PAYMENT_SUCCEEDED: "PAYMENT_SUCCEEDED",
  PAYMENT_FAILED: "PAYMENT_FAILED",
  SUBSCRIPTION_ACTIVATED: "SUBSCRIPTION_ACTIVATED",
  SUBSCRIPTION_CANCELLED: "SUBSCRIPTION_CANCELLED",
  /** Evento reconocido pero sin efecto en el estado de la cuenta. */
  IGNORED: "IGNORED",
} as const;
export type BillingEventType = (typeof BillingEventType)[keyof typeof BillingEventType];

export interface NormalizedBillingEvent {
  type: BillingEventType;
  /** Id del evento en la pasarela. Da la idempotencia. */
  externalEventId: string;
  provider: PaymentProvider;
  /** `external_reference`: identifica la empresa y el plan contratado. */
  externalReference: string | null;
  externalSubscriptionId: string | null;
  externalInvoiceId: string | null;
  amountCents: number | null;
  currency: string | null;
  tier: SubscriptionTier | null;
  interval: BillingInterval | null;
  /** Tipo original de la pasarela, para el rastro. */
  rawType: string;
  occurredAt: Date;
}

export interface SubscriptionSummary {
  tier: SubscriptionTier;
  status: string;
  accountStatus: string;
  interval: BillingInterval;
  provider: PaymentProvider;
  currentPeriodEnd: string | null;
  trialEndsAt: string | null;
  trialDaysLeft: number | null;
  graceEndsAt: string | null;
  cancelAtPeriodEnd: boolean;
  amountCents: number;
  currency: string;
}
