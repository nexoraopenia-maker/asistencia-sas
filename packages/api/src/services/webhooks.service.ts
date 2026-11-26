import { createHmac, timingSafeEqual } from "node:crypto";
import { db, getSystemClient } from "@scire/database";
import { loadConfig } from "../config.js";

/**
 * Notificaciones salientes hacia n8n / Evolution API (WhatsApp corporativo).
 *
 * Se usa el patron **outbox**: la marcacion escribe una fila en
 * `WebhookDelivery` dentro de su propio flujo y termina. Un despachador aparte
 * hace las entregas HTTP con reintentos y backoff exponencial.
 *
 * El desacople no es adorno: si n8n esta caido o tarda 30 s en responder, un
 * empleado fichando a las 9 de la manana no puede quedarse esperando —ni
 * perder su marcacion— por culpa de una notificacion. La marcacion se confirma
 * siempre; la notificacion llega cuando pueda.
 */

/** Eventos que puede emitir la plataforma. */
export const WebhookEvent = {
  PUNCH_CREATED: "punch.created",
  PUNCH_LATE: "punch.late",
  PUNCH_MOCK_LOCATION: "punch.mock_location",
  PUNCH_OUTSIDE_GEOFENCE: "punch.outside_geofence",
  ABSENCE_CREATED: "absence.created",
  ABSENCE_REVIEWED: "absence.reviewed",
  /** Cobro rechazado: la cuenta entra en periodo de gracia. */
  BILLING_PAYMENT_FAILED: "billing.payment_failed",
  BILLING_SUBSCRIPTION_CANCELLED: "billing.subscription_cancelled",
  /** El trial esta a punto de vencer. */
  BILLING_TRIAL_ENDING: "billing.trial_ending",
} as const;
export type WebhookEvent = (typeof WebhookEvent)[keyof typeof WebhookEvent];

/**
 * Encola un evento para todos los endpoints activos de la empresa suscritos a
 * ese tipo. Se llama DENTRO del contexto de tenant, asi que `db` ya filtra.
 *
 * Nunca lanza: un fallo al encolar una notificacion no puede tumbar la
 * operacion de negocio que la origino.
 */
export async function emitEvent(
  eventType: WebhookEvent,
  payload: Record<string, unknown>,
): Promise<number> {
  try {
    const endpoints = await db.webhookEndpoint.findMany({
      where: { isActive: true, events: { has: eventType } },
      select: { id: true, companyId: true },
    });

    if (endpoints.length === 0) return 0;

    await db.webhookDelivery.createMany({
      data: endpoints.map((endpoint) => ({
        companyId: endpoint.companyId,
        endpointId: endpoint.id,
        eventType,
        payload: { event: eventType, occurredAt: new Date().toISOString(), data: payload },
        nextRetryAt: new Date(),
      })),
    });

    return endpoints.length;
  } catch (error) {
    console.error("[webhooks] no se pudo encolar el evento", { eventType, error });
    return 0;
  }
}

/**
 * Firma el cuerpo con HMAC-SHA256 al estilo Stripe: `t=<unix>,v1=<hex>`.
 *
 * El timestamp entra en la firma para que el receptor pueda rechazar reenvios
 * antiguos; sin el, una entrega capturada seria reproducible indefinidamente.
 */
export function signPayload(secret: string, body: string, timestamp: number): string {
  const signature = createHmac("sha256", secret)
    .update(`${timestamp}.${body}`)
    .digest("hex");
  return `t=${timestamp},v1=${signature}`;
}

/** Verificacion en tiempo constante, para el lado receptor y para los tests. */
export function verifySignature(
  secret: string,
  body: string,
  header: string,
  toleranceSeconds = 300,
): boolean {
  const parts = Object.fromEntries(
    header.split(",").map((part) => part.split("=") as [string, string]),
  );
  const timestamp = Number(parts.t);
  if (!Number.isFinite(timestamp)) return false;
  if (Math.abs(Date.now() / 1000 - timestamp) > toleranceSeconds) return false;

  const expected = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  const received = parts.v1 ?? "";
  if (expected.length !== received.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(received));
}

/** Backoff exponencial con techo: 30 s, 1 min, 2 min, 4 min... hasta 1 hora. */
function nextRetryDelayMs(attempts: number): number {
  return Math.min(30_000 * 2 ** attempts, 3_600_000);
}

export interface DispatchResult {
  processed: number;
  delivered: number;
  failed: number;
}

/**
 * Procesa las entregas pendientes.
 *
 * Corre fuera de cualquier request, asi que usa `getSystemClient()`: recorre
 * las entregas de TODAS las empresas a proposito.
 */
export async function dispatchPending(limit = 50): Promise<DispatchResult> {
  const config = loadConfig();
  const system = getSystemClient();
  const now = new Date();

  const pending = await system.webhookDelivery.findMany({
    where: {
      deliveredAt: null,
      attempts: { lt: config.WEBHOOK_MAX_ATTEMPTS },
      OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: now } }],
    },
    include: { endpoint: { select: { id: true, url: true, secret: true, isActive: true } } },
    orderBy: { createdAt: "asc" },
    take: limit,
  });

  let delivered = 0;
  let failed = 0;

  for (const delivery of pending) {
    if (!delivery.endpoint.isActive) continue;

    const body = JSON.stringify(delivery.payload);
    const timestamp = Math.floor(Date.now() / 1000);
    const attempts = delivery.attempts + 1;

    try {
      // Timeout explicito: un endpoint que no responde no puede bloquear la
      // cola del resto de empresas.
      const response = await fetch(delivery.endpoint.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Scire-Event": delivery.eventType,
          "X-Scire-Delivery": delivery.id,
          "X-Scire-Signature": signPayload(delivery.endpoint.secret, body, timestamp),
        },
        body,
        signal: AbortSignal.timeout(10_000),
      });

      if (response.ok) {
        await system.webhookDelivery.update({
          where: { id: delivery.id },
          data: {
            attempts,
            deliveredAt: new Date(),
            lastAttemptAt: new Date(),
            responseCode: response.status,
            nextRetryAt: null,
            error: null,
          },
        });
        await system.webhookEndpoint.update({
          where: { id: delivery.endpoint.id },
          data: { lastDeliveryAt: new Date(), failureCount: 0 },
        });
        delivered++;
        continue;
      }

      await recordFailure(delivery.id, delivery.endpoint.id, attempts, response.status, `HTTP ${response.status}`);
      failed++;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await recordFailure(delivery.id, delivery.endpoint.id, attempts, null, message);
      failed++;
    }
  }

  return { processed: pending.length, delivered, failed };
}

async function recordFailure(
  deliveryId: string,
  endpointId: string,
  attempts: number,
  responseCode: number | null,
  error: string,
): Promise<void> {
  const config = loadConfig();
  const system = getSystemClient();

  await system.webhookDelivery.update({
    where: { id: deliveryId },
    data: {
      attempts,
      lastAttemptAt: new Date(),
      responseCode,
      error: error.slice(0, 500),
      nextRetryAt: new Date(Date.now() + nextRetryDelayMs(attempts)),
    },
  });

  const endpoint = await system.webhookEndpoint.update({
    where: { id: endpointId },
    data: { failureCount: { increment: 1 } },
    select: { failureCount: true },
  });

  // Un endpoint que acumula fallos se desactiva solo: seguir reintentando
  // contra una URL muerta solo consume recursos y llena la tabla de entregas.
  if (endpoint.failureCount >= config.WEBHOOK_MAX_ATTEMPTS * 3) {
    await system.webhookEndpoint.update({
      where: { id: endpointId },
      data: { isActive: false },
    });
    console.warn(`[webhooks] endpoint ${endpointId} desactivado tras fallos repetidos`);
  }
}

/** Arranca el bucle del despachador. Devuelve la funcion para detenerlo. */
export function startWebhookDispatcher(): () => void {
  const config = loadConfig();
  const intervalMs = config.WEBHOOK_DISPATCH_INTERVAL_SECONDS * 1000;
  let running = false;

  const timer = setInterval(() => {
    if (running) return; // evita solapes si una tanda tarda mas que el intervalo
    running = true;
    dispatchPending()
      .catch((error) => console.error("[webhooks] fallo el despachador", error))
      .finally(() => {
        running = false;
      });
  }, intervalMs);

  // No mantiene vivo el proceso: si no hay nada mas que hacer, Node puede salir.
  timer.unref();
  return () => clearInterval(timer);
}
