import { createHmac, timingSafeEqual } from "node:crypto";
import {
  AppError,
  BillingEventType,
  BillingInterval,
  ErrorCode,
  PaymentProvider,
  SubscriptionTier,
  chargeAmountCents,
  type CheckoutSession,
  type NormalizedBillingEvent,
} from "@scire/shared";
import { loadConfig } from "../../config.js";

/**
 * Adaptadores de pasarela de pago.
 *
 * Cada pasarela habla su propio idioma. Este modulo las reduce a dos
 * operaciones —crear un checkout y normalizar un evento— de modo que
 * `billing.service.ts` no sabe con quien esta hablando y anadir una tercera
 * pasarela no toca la logica de negocio.
 *
 * Se usa la **API REST con `fetch`** en vez de los SDK oficiales: ambos SDK
 * arrastran decenas de dependencias transitivas para lo poco que se necesita
 * aqui (dos endpoints y una verificacion HMAC), y la superficie de una
 * pasarela de pago es justo donde menos conviene tener codigo de terceros sin
 * revisar.
 */

export interface BillingProvider {
  readonly id: PaymentProvider;
  /** Crea el enlace de pago para un plan y periodicidad. */
  createCheckout(input: CheckoutInput): Promise<CheckoutSession>;
  /**
   * Verifica la firma del webhook. Devuelve `false` si no valida: el llamante
   * responde 401 sin tocar nada.
   */
  verifySignature(input: WebhookInput): boolean;
  /** Traduce el payload de la pasarela al evento normalizado. */
  parseEvent(input: WebhookInput): Promise<NormalizedBillingEvent | null>;
}

export interface CheckoutInput {
  companyId: string;
  companyName: string;
  payerEmail: string;
  tier: SubscriptionTier;
  interval: BillingInterval;
  /** `external_reference`: vuelve intacta en el webhook. */
  externalReference: string;
}

export interface WebhookInput {
  /** Cuerpo SIN parsear. La firma se calcula sobre los bytes exactos. */
  rawBody: string;
  headers: Record<string, string | undefined>;
  query: Record<string, string | undefined>;
}

/** `scire:<companyId>:<tier>:<interval>:<nonce>` */
export function buildExternalReference(
  companyId: string,
  tier: SubscriptionTier,
  interval: BillingInterval,
): string {
  return `scire:${companyId}:${tier}:${interval}:${Date.now().toString(36)}`;
}

export interface ParsedReference {
  companyId: string;
  tier: SubscriptionTier;
  interval: BillingInterval;
}

export function parseExternalReference(reference: string | null): ParsedReference | null {
  if (!reference?.startsWith("scire:")) return null;
  const [, companyId, tier, interval] = reference.split(":");
  if (!companyId || !tier || !interval) return null;
  if (!(tier in SubscriptionTier) || !(interval in BillingInterval)) return null;
  return {
    companyId,
    tier: tier as SubscriptionTier,
    interval: interval as BillingInterval,
  };
}

/** Comparacion en tiempo constante tolerante a longitudes distintas. */
function safeEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}

// =============================================================================
// MercadoPago
// =============================================================================

const MP_API = "https://api.mercadopago.com";

/** Frecuencia de cobro en el vocabulario de MercadoPago. */
const MP_FREQUENCY: Record<BillingInterval, { frequency: number; frequency_type: string }> = {
  MONTHLY: { frequency: 1, frequency_type: "months" },
  YEARLY: { frequency: 12, frequency_type: "months" },
};

export const mercadoPagoProvider: BillingProvider = {
  id: PaymentProvider.MERCADOPAGO,

  async createCheckout(input) {
    const config = loadConfig();
    if (!config.MERCADOPAGO_ACCESS_TOKEN) {
      throw new AppError(
        ErrorCode.PAYMENT_REQUIRED,
        "MercadoPago no esta configurado en el servidor. Revisa MERCADOPAGO_ACCESS_TOKEN.",
      );
    }

    const amountCents = chargeAmountCents(input.tier, input.interval);
    const body = {
      reason: `Scire 360 Chronos · Plan ${input.tier} (${input.companyName})`,
      external_reference: input.externalReference,
      payer_email: input.payerEmail,
      back_url: `${config.APP_URL}/dashboard/suscripcion?checkout=done`,
      auto_recurring: {
        ...MP_FREQUENCY[input.interval],
        transaction_amount: amountCents / 100,
        currency_id: config.BILLING_CURRENCY,
      },
      status: "pending",
    };

    const response = await fetch(`${MP_API}/preapproval`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.MERCADOPAGO_ACCESS_TOKEN}`,
        // Evita crear dos suscripciones si la peticion se reintenta.
        "X-Idempotency-Key": input.externalReference,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });

    const payload = (await response.json().catch(() => null)) as
      | { init_point?: string; id?: string; message?: string }
      | null;

    if (!response.ok || !payload?.init_point) {
      throw new AppError(
        ErrorCode.PAYMENT_REQUIRED,
        `MercadoPago rechazo la creacion del pago: ${payload?.message ?? response.status}`,
      );
    }

    return {
      checkoutUrl: payload.init_point,
      provider: PaymentProvider.MERCADOPAGO,
      tier: input.tier,
      interval: input.interval,
      amountCents,
      currency: config.BILLING_CURRENCY,
      externalReference: input.externalReference,
      expiresAt: null,
    };
  },

  /**
   * Firma de MercadoPago.
   *
   * La cabecera `x-signature` llega como `ts=<unix>,v1=<hmac>`, y el HMAC se
   * calcula sobre el manifiesto `id:<data.id>;request-id:<x-request-id>;ts:<ts>;`
   * — no sobre el cuerpo. Es una particularidad de MercadoPago que hay que
   * respetar al pie de la letra o ninguna firma valida.
   */
  verifySignature({ headers, query }) {
    const config = loadConfig();
    const secret = config.MERCADOPAGO_WEBHOOK_SECRET;
    if (!secret) return false;

    const signature = headers["x-signature"];
    const requestId = headers["x-request-id"] ?? "";
    if (!signature) return false;

    const parts = Object.fromEntries(
      signature.split(",").map((part) => part.split("=").map((s) => s.trim()) as [string, string]),
    );
    const ts = parts.ts;
    const v1 = parts.v1;
    if (!ts || !v1) return false;

    // Ventana temporal: sin ella, una notificacion capturada seria
    // reproducible indefinidamente.
    const ageSeconds = Math.abs(Date.now() / 1000 - Number(ts));
    if (!Number.isFinite(ageSeconds) || ageSeconds > 600) return false;

    const dataId = query["data.id"] ?? query.id ?? "";
    const manifest = `id:${dataId};request-id:${requestId};ts:${ts};`;
    const expected = createHmac("sha256", secret).update(manifest).digest("hex");

    return safeEqual(expected, v1);
  },

  async parseEvent({ rawBody, query }) {
    const config = loadConfig();
    const body = JSON.parse(rawBody || "{}") as {
      id?: number | string;
      type?: string;
      action?: string;
      data?: { id?: string };
    };

    const rawType = body.action ?? body.type ?? query.topic ?? "unknown";
    const resourceId = String(body.data?.id ?? query["data.id"] ?? query.id ?? "");
    // El id del evento y el del recurso son distintos: el primero da
    // idempotencia, el segundo identifica el pago o la suscripcion.
    const externalEventId = String(body.id ?? `${rawType}:${resourceId}`);

    const base = {
      externalEventId,
      provider: PaymentProvider.MERCADOPAGO,
      externalInvoiceId: null as string | null,
      externalSubscriptionId: null as string | null,
      amountCents: null as number | null,
      currency: config.BILLING_CURRENCY as string | null,
      rawType,
      occurredAt: new Date(),
    };

    // Los webhooks de MercadoPago traen solo el id: hay que ir a buscar el
    // recurso. Es un viaje mas, pero es la unica forma de conocer el estado
    // real; fiarse del tipo de notificacion deja huecos.
    if (rawType.startsWith("payment")) {
      const payment = await fetchMercadoPago<{
        status?: string;
        transaction_amount?: number;
        currency_id?: string;
        external_reference?: string;
        preapproval_id?: string;
        id?: number;
      }>(`/v1/payments/${resourceId}`);

      if (!payment) return null;

      const approved = payment.status === "approved";
      return {
        ...base,
        type: approved ? BillingEventType.PAYMENT_SUCCEEDED : BillingEventType.PAYMENT_FAILED,
        externalReference: payment.external_reference ?? null,
        externalSubscriptionId: payment.preapproval_id ?? null,
        externalInvoiceId: String(payment.id ?? resourceId),
        amountCents: payment.transaction_amount
          ? Math.round(payment.transaction_amount * 100)
          : null,
        currency: payment.currency_id ?? base.currency,
        tier: null,
        interval: null,
      };
    }

    if (rawType.startsWith("preapproval") || rawType.startsWith("subscription")) {
      const preapproval = await fetchMercadoPago<{
        status?: string;
        external_reference?: string;
        id?: string;
      }>(`/preapproval/${resourceId}`);

      if (!preapproval) return null;

      const type =
        preapproval.status === "authorized"
          ? BillingEventType.SUBSCRIPTION_ACTIVATED
          : preapproval.status === "cancelled"
            ? BillingEventType.SUBSCRIPTION_CANCELLED
            : preapproval.status === "paused"
              ? BillingEventType.PAYMENT_FAILED
              : BillingEventType.IGNORED;

      return {
        ...base,
        type,
        externalReference: preapproval.external_reference ?? null,
        externalSubscriptionId: preapproval.id ?? resourceId,
        tier: null,
        interval: null,
      };
    }

    return { ...base, type: BillingEventType.IGNORED, externalReference: null, tier: null, interval: null };
  },
};

async function fetchMercadoPago<T>(path: string): Promise<T | null> {
  const config = loadConfig();
  if (!config.MERCADOPAGO_ACCESS_TOKEN) return null;
  try {
    const response = await fetch(`${MP_API}${path}`, {
      headers: { Authorization: `Bearer ${config.MERCADOPAGO_ACCESS_TOKEN}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

// =============================================================================
// Stripe
// =============================================================================

const STRIPE_API = "https://api.stripe.com/v1";

export const stripeProvider: BillingProvider = {
  id: PaymentProvider.STRIPE,

  async createCheckout(input) {
    const config = loadConfig();
    if (!config.STRIPE_SECRET_KEY) {
      throw new AppError(
        ErrorCode.PAYMENT_REQUIRED,
        "Stripe no esta configurado en el servidor. Revisa STRIPE_SECRET_KEY.",
      );
    }

    const amountCents = chargeAmountCents(input.tier, input.interval);

    // Stripe espera `application/x-www-form-urlencoded`, no JSON.
    const form = new URLSearchParams({
      mode: "subscription",
      customer_email: input.payerEmail,
      client_reference_id: input.externalReference,
      success_url: `${config.APP_URL}/dashboard/suscripcion?checkout=done`,
      cancel_url: `${config.APP_URL}/dashboard/suscripcion?checkout=cancelled`,
      "line_items[0][quantity]": "1",
      "line_items[0][price_data][currency]": config.BILLING_CURRENCY.toLowerCase(),
      "line_items[0][price_data][unit_amount]": String(amountCents),
      "line_items[0][price_data][recurring][interval]":
        input.interval === BillingInterval.YEARLY ? "year" : "month",
      "line_items[0][price_data][product_data][name]": `Scire 360 Chronos · ${input.tier}`,
      "subscription_data[metadata][external_reference]": input.externalReference,
      "metadata[external_reference]": input.externalReference,
    });

    const response = await fetch(`${STRIPE_API}/checkout/sessions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.STRIPE_SECRET_KEY}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "Idempotency-Key": input.externalReference,
      },
      body: form,
      signal: AbortSignal.timeout(15_000),
    });

    const payload = (await response.json().catch(() => null)) as
      | { url?: string; expires_at?: number; error?: { message?: string } }
      | null;

    if (!response.ok || !payload?.url) {
      throw new AppError(
        ErrorCode.PAYMENT_REQUIRED,
        `Stripe rechazo la creacion del pago: ${payload?.error?.message ?? response.status}`,
      );
    }

    return {
      checkoutUrl: payload.url,
      provider: PaymentProvider.STRIPE,
      tier: input.tier,
      interval: input.interval,
      amountCents,
      currency: config.BILLING_CURRENCY,
      externalReference: input.externalReference,
      expiresAt: payload.expires_at ? new Date(payload.expires_at * 1000).toISOString() : null,
    };
  },

  /** `Stripe-Signature: t=<unix>,v1=<hmac>` sobre `<t>.<rawBody>`. */
  verifySignature({ rawBody, headers }) {
    const config = loadConfig();
    const secret = config.STRIPE_WEBHOOK_SECRET;
    if (!secret) return false;

    const header = headers["stripe-signature"];
    if (!header) return false;

    const parts = header.split(",").map((part) => part.split("=") as [string, string]);
    const ts = parts.find(([key]) => key === "t")?.[1];
    // Stripe puede enviar varias v1 durante una rotacion de secreto: vale
    // cualquiera de ellas.
    const signatures = parts.filter(([key]) => key === "v1").map(([, value]) => value);
    if (!ts || signatures.length === 0) return false;

    if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;

    const expected = createHmac("sha256", secret).update(`${ts}.${rawBody}`).digest("hex");
    return signatures.some((signature) => safeEqual(expected, signature));
  },

  async parseEvent({ rawBody }) {
    const config = loadConfig();
    const event = JSON.parse(rawBody || "{}") as {
      id?: string;
      type?: string;
      created?: number;
      data?: { object?: Record<string, unknown> };
    };

    const object = event.data?.object ?? {};
    const rawType = event.type ?? "unknown";

    const reference =
      (object.client_reference_id as string | undefined) ??
      ((object.metadata as Record<string, string> | undefined)?.external_reference ?? null);

    const base = {
      externalEventId: event.id ?? `stripe:${Date.now()}`,
      provider: PaymentProvider.STRIPE,
      externalReference: reference,
      externalSubscriptionId: (object.subscription as string | undefined) ?? (object.id as string | undefined) ?? null,
      externalInvoiceId: (object.id as string | undefined) ?? null,
      amountCents:
        (object.amount_paid as number | undefined) ??
        (object.amount_total as number | undefined) ??
        (object.amount_due as number | undefined) ??
        null,
      currency: ((object.currency as string | undefined) ?? config.BILLING_CURRENCY).toUpperCase(),
      tier: null,
      interval: null,
      rawType,
      occurredAt: event.created ? new Date(event.created * 1000) : new Date(),
    };

    switch (rawType) {
      case "checkout.session.completed":
      case "customer.subscription.created":
        return { ...base, type: BillingEventType.SUBSCRIPTION_ACTIVATED };
      case "invoice.paid":
      case "invoice.payment_succeeded":
        return { ...base, type: BillingEventType.PAYMENT_SUCCEEDED };
      case "invoice.payment_failed":
        return { ...base, type: BillingEventType.PAYMENT_FAILED };
      case "customer.subscription.deleted":
        return { ...base, type: BillingEventType.SUBSCRIPTION_CANCELLED };
      default:
        return { ...base, type: BillingEventType.IGNORED };
    }
  },
};

export function getProvider(provider?: PaymentProvider): BillingProvider {
  const configured = provider ?? loadConfig().BILLING_PROVIDER;
  return configured === PaymentProvider.STRIPE ? stripeProvider : mercadoPagoProvider;
}
