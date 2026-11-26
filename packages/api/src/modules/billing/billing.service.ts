import { db, getSystemClient, Prisma } from "@scire/database";
import {
  AccountStatus,
  AppError,
  BillingEventType,
  BillingInterval,
  DEFAULT_TRIAL_DAYS,
  ErrorCode,
  InvoiceStatus,
  PAST_DUE_GRACE_DAYS,
  PLAN_LIMITS,
  PaymentProvider,
  SubscriptionStatus,
  SubscriptionTier,
  UserStatus,
  chargeAmountCents,
  type CheckoutSession,
  type CreateCheckoutInput,
  type NormalizedBillingEvent,
  type SubscriptionSummary,
} from "@scire/shared";
import { loadConfig } from "../../config.js";
import { emitEvent, WebhookEvent } from "../../services/webhooks.service.js";
import {
  buildExternalReference,
  getProvider,
  parseExternalReference,
  type WebhookInput,
} from "./providers.js";

/**
 * Facturacion y ciclo de vida de la suscripcion.
 *
 * Los webhooks corren FUERA de cualquier contexto de tenant —la pasarela no
 * sabe nada de JWTs— asi que usan `getSystemClient()` y resuelven la empresa
 * desde el `external_reference`. Es uno de los usos legitimos documentados en
 * docs/multitenancy.md.
 */

const system = getSystemClient();

/** Dias entre `now` y `date`, redondeando hacia arriba. Nunca negativo. */
function daysUntil(date: Date | null): number | null {
  if (!date) return null;
  return Math.max(0, Math.ceil((date.getTime() - Date.now()) / 86_400_000));
}

function addDays(base: Date, days: number): Date {
  return new Date(base.getTime() + days * 86_400_000);
}

function addInterval(base: Date, interval: BillingInterval): Date {
  const next = new Date(base);
  next.setMonth(next.getMonth() + (interval === BillingInterval.YEARLY ? 12 : 1));
  return next;
}

// =============================================================================
// Consulta
// =============================================================================

export async function getSubscriptionSummary(companyId: string): Promise<SubscriptionSummary> {
  const [company, subscription] = await Promise.all([
    system.company.findUniqueOrThrow({
      where: { id: companyId },
      select: { tier: true, accountStatus: true, graceEndsAt: true },
    }),
    system.subscription.findUnique({ where: { companyId } }),
  ]);

  return {
    tier: company.tier as SubscriptionTier,
    status: subscription?.status ?? SubscriptionStatus.TRIALING,
    accountStatus: company.accountStatus,
    interval: (subscription?.interval ?? BillingInterval.MONTHLY) as BillingInterval,
    provider: (subscription?.provider ?? PaymentProvider.MERCADOPAGO) as PaymentProvider,
    currentPeriodEnd: subscription?.currentPeriodEnd?.toISOString() ?? null,
    trialEndsAt: subscription?.trialEndsAt?.toISOString() ?? null,
    trialDaysLeft: daysUntil(subscription?.trialEndsAt ?? null),
    graceEndsAt: company.graceEndsAt?.toISOString() ?? null,
    cancelAtPeriodEnd: subscription?.cancelAtPeriodEnd ?? false,
    amountCents: subscription?.amountCents ?? 0,
    currency: subscription?.currency ?? loadConfig().BILLING_CURRENCY,
  };
}

// =============================================================================
// Checkout
// =============================================================================

export async function createCheckoutSession(
  companyId: string,
  payerEmail: string,
  input: CreateCheckoutInput,
): Promise<CheckoutSession> {
  const company = await system.company.findUniqueOrThrow({
    where: { id: companyId },
    select: { id: true, name: true, tier: true },
  });

  // Un downgrade con asientos de sobra dejaria a la empresa por encima de su
  // nuevo cupo el mismo dia del cambio. Se bloquea antes de cobrar: cobrar y
  // luego rechazar es la peor combinacion posible.
  const targetLimit = PLAN_LIMITS[input.tier].maxEmployees;
  const seatsUsed = await system.user.count({
    where: { companyId, status: { in: [UserStatus.ACTIVE, UserStatus.INVITED] } },
  });
  if (seatsUsed > targetLimit) {
    throw new AppError(
      ErrorCode.EMPLOYEE_LIMIT_REACHED,
      `Tienes ${seatsUsed} colaboradores y el plan ${PLAN_LIMITS[input.tier].displayName} admite ${targetLimit}. Da de baja a los que sobren antes de cambiar de plan.`,
      { seatsUsed, targetLimit, tier: input.tier },
    );
  }

  const provider = getProvider(input.provider);
  const externalReference = buildExternalReference(companyId, input.tier, input.interval);

  const session = await provider.createCheckout({
    companyId: company.id,
    companyName: company.name,
    payerEmail,
    tier: input.tier,
    interval: input.interval,
    externalReference,
  });

  // Se guarda la referencia ANTES de redirigir: si el webhook llega mientras
  // el usuario sigue en la pasarela, la empresa ya es resoluble.
  await system.subscription.upsert({
    where: { companyId },
    update: { provider: provider.id, interval: input.interval },
    create: {
      companyId,
      tier: company.tier as SubscriptionTier,
      status: SubscriptionStatus.TRIALING,
      provider: provider.id,
      interval: input.interval,
      seats: PLAN_LIMITS[company.tier as SubscriptionTier].maxEmployees,
    },
  });

  return session;
}

// =============================================================================
// Webhooks
// =============================================================================

export interface WebhookResult {
  status: "processed" | "duplicate" | "ignored" | "unresolved";
  eventType: string;
  companyId?: string;
}

/**
 * Procesa un webhook de facturacion.
 *
 * **Idempotencia**: `BillingWebhookEvent` tiene un unico sobre
 * `(provider, externalEventId)`. La fila se inserta ANTES de aplicar ningun
 * cambio; si ya existe y esta procesada, se sale sin tocar nada. Las pasarelas
 * reintentan de forma agresiva y un evento aplicado dos veces significaria
 * duplicar una factura o extender un periodo que no se ha pagado.
 */
export async function processWebhook(
  providerId: PaymentProvider,
  input: WebhookInput,
): Promise<WebhookResult> {
  const provider = getProvider(providerId);

  if (!provider.verifySignature(input)) {
    throw new AppError(ErrorCode.UNAUTHENTICATED, "Firma del webhook invalida");
  }

  const event = await provider.parseEvent(input);
  if (!event) {
    return { status: "ignored", eventType: "unparseable" };
  }

  const reference = parseExternalReference(event.externalReference);

  // Registro de recepcion. El unique compuesto es el que arbitra: si dos
  // reintentos llegan a la vez, solo uno crea la fila.
  try {
    await system.billingWebhookEvent.create({
      data: {
        provider: providerId,
        externalEventId: event.externalEventId,
        eventType: event.rawType,
        companyId: reference?.companyId ?? null,
        payload: JSON.parse(input.rawBody || "{}") as Prisma.InputJsonValue,
      },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const existing = await system.billingWebhookEvent.findUnique({
        where: {
          provider_externalEventId: {
            provider: providerId,
            externalEventId: event.externalEventId,
          },
        },
        select: { processedAt: true },
      });
      // Solo se considera duplicado si YA se aplico. Un evento recibido pero
      // que fallo a medias debe poder reintentarse.
      if (existing?.processedAt) {
        return { status: "duplicate", eventType: event.rawType };
      }
    } else {
      throw error;
    }
  }

  if (event.type === BillingEventType.IGNORED) {
    await markProcessed(providerId, event.externalEventId);
    return { status: "ignored", eventType: event.rawType };
  }

  if (!reference) {
    await markProcessed(
      providerId,
      event.externalEventId,
      "external_reference ausente o no reconocible",
    );
    return { status: "unresolved", eventType: event.rawType };
  }

  const company = await system.company.findUnique({
    where: { id: reference.companyId },
    select: { id: true },
  });
  if (!company) {
    await markProcessed(providerId, event.externalEventId, "La empresa ya no existe");
    return { status: "unresolved", eventType: event.rawType };
  }

  await applyEvent(event, reference, providerId);
  await markProcessed(providerId, event.externalEventId);

  return { status: "processed", eventType: event.rawType, companyId: reference.companyId };
}

async function markProcessed(
  provider: PaymentProvider,
  externalEventId: string,
  error?: string,
): Promise<void> {
  await system.billingWebhookEvent.updateMany({
    where: { provider, externalEventId },
    data: { processedAt: new Date(), attempts: { increment: 1 }, error: error ?? null },
  });
}

/**
 * Aplica el efecto del evento en una transaccion.
 *
 * Company, Subscription e Invoice se mueven juntos o no se mueven: una cuenta
 * marcada ACTIVE sin la factura correspondiente, o una factura pagada con la
 * cuenta suspendida, son estados que nadie sabria interpretar despues.
 */
async function applyEvent(
  event: NormalizedBillingEvent,
  reference: { companyId: string; tier: SubscriptionTier; interval: BillingInterval },
  providerId: PaymentProvider,
): Promise<void> {
  const config = loadConfig();
  const now = new Date();
  const plan = PLAN_LIMITS[reference.tier];
  const amountCents = event.amountCents ?? chargeAmountCents(reference.tier, reference.interval);
  const currency = event.currency ?? config.BILLING_CURRENCY;

  switch (event.type) {
    case BillingEventType.PAYMENT_SUCCEEDED:
    case BillingEventType.SUBSCRIPTION_ACTIVATED: {
      const periodEnd = addInterval(now, reference.interval);

      await system.$transaction(async (tx) => {
        await tx.company.update({
          where: { id: reference.companyId },
          data: {
            tier: reference.tier,
            maxEmployees: plan.maxEmployees,
            accountStatus: AccountStatus.ACTIVE,
            suspendedAt: null,
            graceEndsAt: null,
          },
        });

        await tx.subscription.upsert({
          where: { companyId: reference.companyId },
          update: {
            tier: reference.tier,
            status: SubscriptionStatus.ACTIVE,
            interval: reference.interval,
            provider: providerId,
            externalSubscriptionId: event.externalSubscriptionId,
            currentPeriodStart: now,
            currentPeriodEnd: periodEnd,
            cancelAtPeriodEnd: false,
            cancelledAt: null,
            seats: plan.maxEmployees,
            amountCents,
            currency,
          },
          create: {
            companyId: reference.companyId,
            tier: reference.tier,
            status: SubscriptionStatus.ACTIVE,
            interval: reference.interval,
            provider: providerId,
            externalSubscriptionId: event.externalSubscriptionId,
            currentPeriodStart: now,
            currentPeriodEnd: periodEnd,
            seats: plan.maxEmployees,
            amountCents,
            currency,
          },
        });

        // Solo un cobro genera factura. La activacion de la suscripcion sin
        // cobro asociado (checkout completado) no debe crear una.
        if (event.type === BillingEventType.PAYMENT_SUCCEEDED) {
          const subscription = await tx.subscription.findUnique({
            where: { companyId: reference.companyId },
            select: { id: true },
          });

          await tx.invoice.upsert({
            where: { externalInvoiceId: event.externalInvoiceId ?? event.externalEventId },
            update: { status: InvoiceStatus.PAID, paidAt: now, failedAt: null, failureReason: null },
            create: {
              companyId: reference.companyId,
              subscriptionId: subscription?.id ?? null,
              provider: providerId,
              externalInvoiceId: event.externalInvoiceId ?? event.externalEventId,
              status: InvoiceStatus.PAID,
              amountCents,
              currency,
              periodStart: now,
              periodEnd,
              issuedAt: event.occurredAt,
              paidAt: now,
            },
          });
        }
      });
      return;
    }

    case BillingEventType.PAYMENT_FAILED: {
      const graceEndsAt = addDays(now, PAST_DUE_GRACE_DAYS);

      await system.$transaction(async (tx) => {
        await tx.company.update({
          where: { id: reference.companyId },
          data: { accountStatus: AccountStatus.PAST_DUE, graceEndsAt },
        });

        await tx.subscription.updateMany({
          where: { companyId: reference.companyId },
          data: { status: SubscriptionStatus.PAST_DUE },
        });

        const subscription = await tx.subscription.findUnique({
          where: { companyId: reference.companyId },
          select: { id: true },
        });

        await tx.invoice.upsert({
          where: { externalInvoiceId: event.externalInvoiceId ?? event.externalEventId },
          update: {
            status: InvoiceStatus.FAILED,
            failedAt: now,
            failureReason: `Cobro rechazado por la pasarela (${event.rawType})`,
          },
          create: {
            companyId: reference.companyId,
            subscriptionId: subscription?.id ?? null,
            provider: providerId,
            externalInvoiceId: event.externalInvoiceId ?? event.externalEventId,
            status: InvoiceStatus.FAILED,
            amountCents,
            currency,
            issuedAt: event.occurredAt,
            failedAt: now,
            failureReason: `Cobro rechazado por la pasarela (${event.rawType})`,
          },
        });
      });

      await notify(reference.companyId, WebhookEvent.BILLING_PAYMENT_FAILED, {
        tier: reference.tier,
        amountCents,
        currency,
        graceEndsAt: graceEndsAt.toISOString(),
      });
      return;
    }

    case BillingEventType.SUBSCRIPTION_CANCELLED: {
      // No se corta el servicio de inmediato: la empresa pago hasta el final
      // del ciclo y tiene derecho a usarlo. El cron de vencimientos suspende
      // cuando llega la fecha.
      const subscription = await system.subscription.findUnique({
        where: { companyId: reference.companyId },
        select: { currentPeriodEnd: true },
      });
      const effectiveAt = subscription?.currentPeriodEnd ?? now;

      await system.$transaction(async (tx) => {
        await tx.subscription.updateMany({
          where: { companyId: reference.companyId },
          data: {
            status: SubscriptionStatus.CANCELLED,
            cancelAtPeriodEnd: true,
            cancelledAt: now,
          },
        });
        await tx.company.update({
          where: { id: reference.companyId },
          data: { graceEndsAt: effectiveAt },
        });
      });

      await notify(reference.companyId, WebhookEvent.BILLING_SUBSCRIPTION_CANCELLED, {
        effectiveAt: effectiveAt.toISOString(),
      });
      return;
    }

    default:
      return;
  }
}

/** Notifica a los endpoints de la empresa sin depender del contexto de tenant. */
async function notify(
  companyId: string,
  eventType: WebhookEvent,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    const endpoints = await system.webhookEndpoint.findMany({
      where: { companyId, isActive: true, events: { has: eventType } },
      select: { id: true },
    });
    if (endpoints.length === 0) return;

    await system.webhookDelivery.createMany({
      data: endpoints.map((endpoint) => ({
        companyId,
        endpointId: endpoint.id,
        eventType,
        payload: {
          event: eventType,
          occurredAt: new Date().toISOString(),
          data: payload,
        } as Prisma.InputJsonValue,
        nextRetryAt: new Date(),
      })),
    });
  } catch (error) {
    console.error("[billing] no se pudo encolar la notificacion", { companyId, eventType, error });
  }
}

// Silencia el aviso de import no usado cuando `emitEvent` no se referencia.
void emitEvent;

// =============================================================================
// Cancelacion desde el panel
// =============================================================================

export async function cancelSubscription(
  companyId: string,
  atPeriodEnd: boolean,
): Promise<SubscriptionSummary> {
  const subscription = await system.subscription.findUnique({
    where: { companyId },
    select: { currentPeriodEnd: true },
  });

  const now = new Date();
  const effectiveAt = atPeriodEnd ? (subscription?.currentPeriodEnd ?? now) : now;

  await system.$transaction(async (tx) => {
    await tx.subscription.updateMany({
      where: { companyId },
      data: {
        status: SubscriptionStatus.CANCELLED,
        cancelAtPeriodEnd: atPeriodEnd,
        cancelledAt: now,
      },
    });
    await tx.company.update({
      where: { id: companyId },
      data: atPeriodEnd
        ? { graceEndsAt: effectiveAt }
        : { accountStatus: AccountStatus.SUSPENDED, suspendedAt: now },
    });
  });

  return getSubscriptionSummary(companyId);
}

// =============================================================================
// Vencimientos
// =============================================================================

export interface ExpirationResult {
  trialsExpired: number;
  graceExpired: number;
}

/**
 * Suspende las cuentas cuyo trial o periodo de gracia ha vencido.
 *
 * Corre en un intervalo, no en cada request: comprobar la caducidad en el
 * camino caliente de la marcacion anadiria una consulta a cada fichaje para
 * detectar algo que cambia una vez al dia.
 */
export async function expireOverdueAccounts(): Promise<ExpirationResult> {
  const now = new Date();

  // Trials vencidos: la suscripcion sigue en TRIALING y la fecha ya paso.
  const expiredTrials = await system.subscription.findMany({
    where: { status: SubscriptionStatus.TRIALING, trialEndsAt: { lt: now } },
    select: { companyId: true },
  });

  for (const { companyId } of expiredTrials) {
    await system.$transaction([
      system.subscription.updateMany({
        where: { companyId },
        data: { status: SubscriptionStatus.SUSPENDED },
      }),
      system.company.update({
        where: { id: companyId },
        data: { accountStatus: AccountStatus.SUSPENDED, suspendedAt: now, graceEndsAt: null },
      }),
    ]);
  }

  // Gracia agotada: morosos y cancelaciones cuyo ciclo pagado ya termino.
  const expiredGrace = await system.company.findMany({
    where: {
      accountStatus: { in: [AccountStatus.PAST_DUE, AccountStatus.ACTIVE] },
      graceEndsAt: { lt: now },
    },
    select: { id: true },
  });

  for (const { id } of expiredGrace) {
    await system.$transaction([
      system.company.update({
        where: { id },
        data: { accountStatus: AccountStatus.SUSPENDED, suspendedAt: now, graceEndsAt: null },
      }),
      system.subscription.updateMany({
        where: { companyId: id },
        data: { status: SubscriptionStatus.SUSPENDED },
      }),
    ]);
  }

  return { trialsExpired: expiredTrials.length, graceExpired: expiredGrace.length };
}

/** Arranca el bucle de vencimientos. Devuelve la funcion para detenerlo. */
export function startBillingScheduler(): () => void {
  const intervalMs = loadConfig().BILLING_EXPIRATION_INTERVAL_MINUTES * 60_000;
  let running = false;

  const timer = setInterval(() => {
    if (running) return;
    running = true;
    expireOverdueAccounts()
      .then((result) => {
        if (result.trialsExpired > 0 || result.graceExpired > 0) {
          console.log("[billing] cuentas suspendidas por vencimiento", result);
        }
      })
      .catch((error) => console.error("[billing] fallo el cron de vencimientos", error))
      .finally(() => {
        running = false;
      });
  }, intervalMs);

  timer.unref();
  return () => clearInterval(timer);
}

/** Trial por defecto de una empresa nueva. Lo usa el onboarding. */
export function defaultTrialEnd(from = new Date()): Date {
  return addDays(from, loadConfig().TRIAL_DAYS || DEFAULT_TRIAL_DAYS);
}
