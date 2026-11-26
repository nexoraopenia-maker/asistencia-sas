import {
  cancelSubscriptionSchema,
  createCheckoutSchema,
  PaymentProvider,
  PLAN_LIMITS,
  TIER_ORDER,
  UserRole,
} from "@scire/shared";
import { getSystemClient } from "@scire/database";
import { Router, type Request } from "express";
import { isBillingConfigured, loadConfig } from "../../config.js";
import { asyncHandler, ok, parseBody } from "../../lib/http.js";
import { requireAuth, requireRole } from "../../middleware/auth.js";
import { getSeatUsage } from "../../middleware/billing.js";
import * as billingService from "./billing.service.js";

export const billingRouter: Router = Router();

/** Catalogo de planes. Publico: alimenta la tabla comparativa de precios. */
billingRouter.get(
  "/plans",
  asyncHandler(async (_req, res) => {
    ok(res, {
      plans: TIER_ORDER.map((tier) => PLAN_LIMITS[tier]),
      currency: loadConfig().BILLING_CURRENCY,
      billingEnabled: isBillingConfigured(loadConfig()),
      provider: loadConfig().BILLING_PROVIDER,
    });
  }),
);

billingRouter.get(
  "/subscription",
  requireAuth,
  requireRole(UserRole.HR_ADMIN),
  asyncHandler(async (req, res) => {
    const companyId = req.auth!.companyId;
    const [summary, seats] = await Promise.all([
      billingService.getSubscriptionSummary(companyId),
      getSeatUsage(companyId),
    ]);
    ok(res, { subscription: summary, seats });
  }),
);

/** Genera el enlace de pago del plan elegido. */
billingRouter.post(
  "/checkout-session",
  requireAuth,
  requireRole(UserRole.HR_ADMIN),
  asyncHandler(async (req, res) => {
    const input = parseBody(createCheckoutSchema, req.body);
    const session = await billingService.createCheckoutSession(
      req.auth!.companyId,
      // El correo del administrador que inicia el pago es el pagador.
      await payerEmailOf(req),
      input,
    );
    ok(res, session, 201);
  }),
);

billingRouter.post(
  "/cancel",
  requireAuth,
  requireRole(UserRole.HR_ADMIN),
  asyncHandler(async (req, res) => {
    const input = parseBody(cancelSubscriptionSchema, req.body);
    ok(res, await billingService.cancelSubscription(req.auth!.companyId, input.atPeriodEnd));
  }),
);

// --- Webhooks ---------------------------------------------------------------

/**
 * Recepcion de eventos de la pasarela.
 *
 * SIN autenticacion por diseno: la pasarela no tiene un JWT. La autenticidad
 * la da la firma criptografica, que se verifica sobre el cuerpo EN CRUDO —de
 * ahi que esta ruta se monte con `express.raw()` antes del parser JSON global.
 *
 * Responde 200 incluso ante eventos que no aplican: un 4xx haria que la
 * pasarela reintentara indefinidamente algo que nunca va a cambiar.
 */
function webhookHandler(provider?: PaymentProvider) {
  return asyncHandler(async (req: Request, res) => {
    const target = provider ?? (loadConfig().BILLING_PROVIDER as PaymentProvider);
    const rawBody = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : String(req.body ?? "");

    const result = await billingService.processWebhook(target, {
      rawBody,
      headers: req.headers as Record<string, string | undefined>,
      query: req.query as Record<string, string | undefined>,
    });

    ok(res, result);
  });
}

/** Ruta generica: usa la pasarela configurada por defecto. */
billingRouter.post("/webhook", webhookHandler());
billingRouter.post("/webhook/mercadopago", webhookHandler(PaymentProvider.MERCADOPAGO));
billingRouter.post("/webhook/stripe", webhookHandler(PaymentProvider.STRIPE));

// --- Helpers ----------------------------------------------------------------

/** Correo del administrador que inicia el pago: es quien figura como pagador. */
async function payerEmailOf(req: Request): Promise<string> {
  const user = await getSystemClient().user.findUnique({
    where: { id: req.auth!.sub },
    select: { email: true },
  });
  return user?.email ?? "";
}
