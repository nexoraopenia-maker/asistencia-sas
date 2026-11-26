import { createHmac, randomUUID } from "node:crypto";
import {
  AccountStatus,
  BillingInterval,
  PaymentProvider,
  PLAN_LIMITS,
  SubscriptionTier,
} from "@scire/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestTenant, request, system, type TestTenant } from "../../test/helpers.js";
import { expireOverdueAccounts } from "./billing.service.js";
import { buildExternalReference, parseExternalReference } from "./providers.js";

/**
 * Tests de facturacion.
 *
 * Los webhooks se simulan firmando el payload con el MISMO algoritmo que usa
 * la pasarela, no saltandose la verificacion: si la firma se calculara mal, el
 * test seguiria pasando y produccion rechazaria todos los eventos.
 *
 * Se usa Stripe para simular porque su firma se calcula sobre el cuerpo, sin
 * necesidad de ir a buscar el recurso a la API remota. MercadoPago exige una
 * llamada de vuelta a su API para conocer el estado real del pago, que no se
 * puede hacer en un test sin credenciales.
 */

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const STRIPE_SECRET = process.env.STRIPE_WEBHOOK_SECRET ?? "whsec_test_scire_360";

let tenant: TestTenant;

beforeAll(async () => {
  // La verificacion de firma lee el secreto de la configuracion, que se
  // memoriza al arrancar: se fija antes de que ningun modulo la lea.
  process.env.STRIPE_WEBHOOK_SECRET = STRIPE_SECRET;
  tenant = await createTestTenant();
});

afterAll(() => tenant.cleanup());

/** Firma un cuerpo igual que lo haria Stripe. */
function stripeSignature(body: string, timestamp = Math.floor(Date.now() / 1000)): string {
  const signature = createHmac("sha256", STRIPE_SECRET)
    .update(`${timestamp}.${body}`)
    .digest("hex");
  return `t=${timestamp},v1=${signature}`;
}

interface StripeEventOptions {
  type: string;
  externalReference: string;
  eventId?: string;
  amountCents?: number;
  objectId?: string;
}

function stripeEvent(options: StripeEventOptions): { body: string; eventId: string } {
  const eventId = options.eventId ?? `evt_${randomUUID().replace(/-/g, "")}`;
  const body = JSON.stringify({
    id: eventId,
    type: options.type,
    created: Math.floor(Date.now() / 1000),
    data: {
      object: {
        id: options.objectId ?? `in_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
        client_reference_id: options.externalReference,
        metadata: { external_reference: options.externalReference },
        subscription: "sub_test_scire",
        amount_paid: options.amountCents ?? 9900,
        currency: "usd",
      },
    },
  });
  return { body, eventId };
}

function postStripeWebhook(body: string, signature?: string) {
  return request(tenant.app)
    .post("/api/v1/billing/webhook/stripe")
    .set("Content-Type", "application/json")
    .set("stripe-signature", signature ?? stripeSignature(body))
    .send(body);
}

/** Devuelve la empresa a un estado conocido entre pruebas. */
async function resetCompany(companyId: string, tier: SubscriptionTier = SubscriptionTier.BUSINESS) {
  await system.company.update({
    where: { id: companyId },
    data: {
      tier,
      maxEmployees: PLAN_LIMITS[tier].maxEmployees,
      accountStatus: AccountStatus.ACTIVE,
      suspendedAt: null,
      graceEndsAt: null,
    },
  });
}

describe("referencia externa", () => {
  it("va y vuelve sin perder la empresa, el plan ni la periodicidad", () => {
    const reference = buildExternalReference(
      "cmp_123",
      SubscriptionTier.BUSINESS,
      BillingInterval.YEARLY,
    );
    expect(parseExternalReference(reference)).toEqual({
      companyId: "cmp_123",
      tier: SubscriptionTier.BUSINESS,
      interval: BillingInterval.YEARLY,
    });
  });

  it("rechaza referencias ajenas o manipuladas", () => {
    expect(parseExternalReference(null)).toBeNull();
    expect(parseExternalReference("otro-sistema:cmp:BUSINESS:MONTHLY")).toBeNull();
    expect(parseExternalReference("scire:cmp:PLAN_FALSO:MONTHLY")).toBeNull();
  });
});

describe("verificacion de firma", () => {
  it("rechaza un webhook sin firma", async () => {
    const { body } = stripeEvent({ type: "invoice.paid", externalReference: "scire:x:BUSINESS:MONTHLY" });
    const response = await request(tenant.app)
      .post("/api/v1/billing/webhook/stripe")
      .set("Content-Type", "application/json")
      .send(body)
      .expect(401);
    expect(response.body.error.code).toBe("UNAUTHENTICATED");
  });

  it("rechaza una firma calculada con otro secreto", async () => {
    const { body } = stripeEvent({ type: "invoice.paid", externalReference: "scire:x:BUSINESS:MONTHLY" });
    const timestamp = Math.floor(Date.now() / 1000);
    const forged = createHmac("sha256", "whsec_secreto_del_atacante")
      .update(`${timestamp}.${body}`)
      .digest("hex");

    await postStripeWebhook(body, `t=${timestamp},v1=${forged}`).expect(401);
  });

  it("rechaza un cuerpo alterado despues de firmar", async () => {
    const { body } = stripeEvent({ type: "invoice.paid", externalReference: "scire:x:BUSINESS:MONTHLY" });
    const signature = stripeSignature(body);
    // Se cambia el importe manteniendo la firma original.
    const tampered = body.replace('"amount_paid":9900', '"amount_paid":1');

    await postStripeWebhook(tampered, signature).expect(401);
  });

  it("rechaza un reenvio antiguo aunque la firma sea correcta", async () => {
    const { body } = stripeEvent({ type: "invoice.paid", externalReference: "scire:x:BUSINESS:MONTHLY" });
    const old = Math.floor(Date.now() / 1000) - 3600;

    await postStripeWebhook(body, stripeSignature(body, old)).expect(401);
  });
});

describe("cobro exitoso", () => {
  beforeEach(() => resetCompany(tenant.companyId));

  it("activa la cuenta, fija el plan y registra la factura", async () => {
    const reference = buildExternalReference(
      tenant.companyId,
      SubscriptionTier.BUSINESS,
      BillingInterval.MONTHLY,
    );
    const { body } = stripeEvent({
      type: "invoice.paid",
      externalReference: reference,
      amountCents: 9900,
    });

    const response = await postStripeWebhook(body).expect(200);
    expect(response.body.data.status).toBe("processed");

    const company = await system.company.findUniqueOrThrow({ where: { id: tenant.companyId } });
    expect(company.accountStatus).toBe(AccountStatus.ACTIVE);
    expect(company.tier).toBe(SubscriptionTier.BUSINESS);
    expect(company.maxEmployees).toBe(PLAN_LIMITS.BUSINESS.maxEmployees);
    expect(company.graceEndsAt).toBeNull();

    const subscription = await system.subscription.findUnique({
      where: { companyId: tenant.companyId },
    });
    expect(subscription?.status).toBe("ACTIVE");
    expect(subscription?.currentPeriodEnd).toBeInstanceOf(Date);

    const invoice = await system.invoice.findFirst({
      where: { companyId: tenant.companyId, status: "PAID" },
    });
    expect(invoice?.amountCents).toBe(9900);
    expect(invoice?.paidAt).toBeInstanceOf(Date);
  });

  it("un upgrade eleva la cuota de asientos de la empresa", async () => {
    await resetCompany(tenant.companyId, SubscriptionTier.STARTER);

    const reference = buildExternalReference(
      tenant.companyId,
      SubscriptionTier.ENTERPRISE,
      BillingInterval.YEARLY,
    );
    const { body } = stripeEvent({ type: "invoice.paid", externalReference: reference });

    await postStripeWebhook(body).expect(200);

    const company = await system.company.findUniqueOrThrow({ where: { id: tenant.companyId } });
    expect(company.tier).toBe(SubscriptionTier.ENTERPRISE);
    expect(company.maxEmployees).toBe(PLAN_LIMITS.ENTERPRISE.maxEmployees);
  });

  it("reactiva una cuenta suspendida", async () => {
    await system.company.update({
      where: { id: tenant.companyId },
      data: { accountStatus: AccountStatus.SUSPENDED, suspendedAt: new Date() },
    });

    const reference = buildExternalReference(
      tenant.companyId,
      SubscriptionTier.BUSINESS,
      BillingInterval.MONTHLY,
    );
    await postStripeWebhook(stripeEvent({ type: "invoice.paid", externalReference: reference }).body).expect(200);

    const company = await system.company.findUniqueOrThrow({ where: { id: tenant.companyId } });
    expect(company.accountStatus).toBe(AccountStatus.ACTIVE);
    expect(company.suspendedAt).toBeNull();
  });
});

describe("idempotencia", () => {
  beforeEach(() => resetCompany(tenant.companyId));

  it("el mismo evento reenviado no crea una segunda factura", async () => {
    const reference = buildExternalReference(
      tenant.companyId,
      SubscriptionTier.BUSINESS,
      BillingInterval.MONTHLY,
    );
    const invoiceId = `in_idem_${Date.now()}`;
    const { body } = stripeEvent({
      type: "invoice.paid",
      externalReference: reference,
      objectId: invoiceId,
    });

    const first = await postStripeWebhook(body).expect(200);
    expect(first.body.data.status).toBe("processed");

    // Las pasarelas reintentan de forma agresiva: el segundo envio es normal.
    const second = await postStripeWebhook(body).expect(200);
    expect(second.body.data.status).toBe("duplicate");

    const invoices = await system.invoice.count({
      where: { companyId: tenant.companyId, externalInvoiceId: invoiceId },
    });
    expect(invoices).toBe(1);

    const events = await system.billingWebhookEvent.count({
      where: { companyId: tenant.companyId, eventType: "invoice.paid" },
    });
    expect(events).toBeGreaterThanOrEqual(1);
  });

  it("dos eventos distintos sobre la misma factura no la duplican", async () => {
    const reference = buildExternalReference(
      tenant.companyId,
      SubscriptionTier.BUSINESS,
      BillingInterval.MONTHLY,
    );
    const invoiceId = `in_shared_${Date.now()}`;

    await postStripeWebhook(
      stripeEvent({ type: "invoice.paid", externalReference: reference, objectId: invoiceId }).body,
    ).expect(200);
    await postStripeWebhook(
      stripeEvent({
        type: "invoice.payment_succeeded",
        externalReference: reference,
        objectId: invoiceId,
      }).body,
    ).expect(200);

    const invoices = await system.invoice.count({ where: { externalInvoiceId: invoiceId } });
    expect(invoices).toBe(1);
  });
});

describe("cobro fallido", () => {
  beforeEach(() => resetCompany(tenant.companyId));

  it("marca PAST_DUE con periodo de gracia y registra el intento", async () => {
    const reference = buildExternalReference(
      tenant.companyId,
      SubscriptionTier.BUSINESS,
      BillingInterval.MONTHLY,
    );
    const { body } = stripeEvent({ type: "invoice.payment_failed", externalReference: reference });

    await postStripeWebhook(body).expect(200);

    const company = await system.company.findUniqueOrThrow({ where: { id: tenant.companyId } });
    expect(company.accountStatus).toBe(AccountStatus.PAST_DUE);
    expect(company.graceEndsAt!.getTime()).toBeGreaterThan(Date.now());

    const invoice = await system.invoice.findFirst({
      where: { companyId: tenant.companyId, status: "FAILED" },
    });
    expect(invoice?.failureReason).toContain("rechazado");
  });

  it("la empresa SIGUE operando durante la gracia", async () => {
    const reference = buildExternalReference(
      tenant.companyId,
      SubscriptionTier.BUSINESS,
      BillingInterval.MONTHLY,
    );
    await postStripeWebhook(
      stripeEvent({ type: "invoice.payment_failed", externalReference: reference }).body,
    ).expect(200);

    // Suspender el fichaje el mismo dia que falla una tarjeta castiga a
    // empleados que no pueden hacer nada al respecto.
    await request(tenant.app)
      .get("/api/v1/auth/me")
      .set(auth(tenant.employee.accessToken))
      .expect(200);
  });
});

describe("cancelacion", () => {
  beforeEach(() => resetCompany(tenant.companyId));

  it("programa la baja para el final del ciclo, sin cortar el servicio", async () => {
    const periodEnd = new Date(Date.now() + 20 * 86_400_000);
    await system.subscription.upsert({
      where: { companyId: tenant.companyId },
      update: { currentPeriodEnd: periodEnd, status: "ACTIVE" },
      create: {
        companyId: tenant.companyId,
        tier: SubscriptionTier.BUSINESS,
        status: "ACTIVE",
        currentPeriodEnd: periodEnd,
      },
    });

    const reference = buildExternalReference(
      tenant.companyId,
      SubscriptionTier.BUSINESS,
      BillingInterval.MONTHLY,
    );
    await postStripeWebhook(
      stripeEvent({ type: "customer.subscription.deleted", externalReference: reference }).body,
    ).expect(200);

    const [company, subscription] = await Promise.all([
      system.company.findUniqueOrThrow({ where: { id: tenant.companyId } }),
      system.subscription.findUniqueOrThrow({ where: { companyId: tenant.companyId } }),
    ]);

    expect(subscription.status).toBe("CANCELLED");
    expect(subscription.cancelAtPeriodEnd).toBe(true);
    // Sigue operando: pago el ciclo y tiene derecho a usarlo.
    expect(company.accountStatus).toBe(AccountStatus.ACTIVE);
    expect(company.graceEndsAt?.getTime()).toBe(periodEnd.getTime());
  });
});

describe("eventos no aplicables", () => {
  it("un tipo desconocido se acepta y se ignora, sin reintentos infinitos", async () => {
    const reference = buildExternalReference(
      tenant.companyId,
      SubscriptionTier.BUSINESS,
      BillingInterval.MONTHLY,
    );
    const response = await postStripeWebhook(
      stripeEvent({ type: "customer.updated", externalReference: reference }).body,
    ).expect(200);

    expect(response.body.data.status).toBe("ignored");
  });

  it("una referencia de otro sistema no toca ninguna empresa", async () => {
    const response = await postStripeWebhook(
      stripeEvent({ type: "invoice.paid", externalReference: "otro-saas:abc" }).body,
    ).expect(200);

    expect(response.body.data.status).toBe("unresolved");
  });

  it("una empresa inexistente no revienta el webhook", async () => {
    const response = await postStripeWebhook(
      stripeEvent({
        type: "invoice.paid",
        externalReference: "scire:cmp_borrada_hace_meses:BUSINESS:MONTHLY",
      }).body,
    ).expect(200);

    expect(response.body.data.status).toBe("unresolved");
  });
});

describe("vencimientos", () => {
  it("suspende una cuenta cuando se agota el periodo de gracia", async () => {
    const overdue = await createTestTenant();
    try {
      await system.company.update({
        where: { id: overdue.companyId },
        data: {
          accountStatus: AccountStatus.PAST_DUE,
          graceEndsAt: new Date(Date.now() - 86_400_000),
        },
      });

      const result = await expireOverdueAccounts();
      expect(result.graceExpired).toBeGreaterThanOrEqual(1);

      const company = await system.company.findUniqueOrThrow({ where: { id: overdue.companyId } });
      expect(company.accountStatus).toBe(AccountStatus.SUSPENDED);
      expect(company.suspendedAt).toBeInstanceOf(Date);

      // Y a partir de ahi nadie de esa empresa puede entrar.
      const login = await request(overdue.app)
        .post("/api/v1/auth/login")
        .send({ email: overdue.employee.email, password: "TestChronos2026!" })
        .expect(402);
      expect(login.body.error.code).toBe("SUBSCRIPTION_INACTIVE");
    } finally {
      await overdue.cleanup();
    }
  });

  it("suspende una cuenta cuyo trial vencio", async () => {
    const trial = await createTestTenant({ accountStatus: AccountStatus.TRIALING });
    try {
      await system.subscription.create({
        data: {
          companyId: trial.companyId,
          tier: SubscriptionTier.BUSINESS,
          status: "TRIALING",
          trialEndsAt: new Date(Date.now() - 86_400_000),
        },
      });

      await expireOverdueAccounts();

      const company = await system.company.findUniqueOrThrow({ where: { id: trial.companyId } });
      expect(company.accountStatus).toBe(AccountStatus.SUSPENDED);
    } finally {
      await trial.cleanup();
    }
  });

  it("no toca una cuenta cuyo trial sigue vigente", async () => {
    const active = await createTestTenant({ accountStatus: AccountStatus.TRIALING });
    try {
      await system.subscription.create({
        data: {
          companyId: active.companyId,
          tier: SubscriptionTier.BUSINESS,
          status: "TRIALING",
          trialEndsAt: new Date(Date.now() + 10 * 86_400_000),
        },
      });

      await expireOverdueAccounts();

      const company = await system.company.findUniqueOrThrow({ where: { id: active.companyId } });
      expect(company.accountStatus).toBe(AccountStatus.TRIALING);
    } finally {
      await active.cleanup();
    }
  });
});

describe("catalogo de planes", () => {
  it("expone la tarifa completa sin necesidad de sesion", async () => {
    const response = await request(tenant.app).get("/api/v1/billing/plans").expect(200);
    const tiers = response.body.data.plans.map((p: { tier: string }) => p.tier);
    expect(tiers).toEqual(["FREE", "STARTER", "BUSINESS", "ENTERPRISE"]);

    const business = response.body.data.plans.find((p: { tier: string }) => p.tier === "BUSINESS");
    expect(business.maxEmployees).toBe(50);
    expect(business.yearlyPriceUsd).toBeLessThan(business.monthlyPriceUsd);
  });
});

describe("checkout", () => {
  it("bloquea el downgrade si la empresa no cabe en el plan destino", async () => {
    const crowded = await createTestTenant();
    try {
      // El helper crea 3 usuarios. Se anaden 9 invitados mas para superar los
      // 10 asientos de STARTER: una invitacion pendiente ya reserva plaza.
      await system.user.createMany({
        data: Array.from({ length: 9 }, (_, index) => ({
          companyId: crowded.companyId,
          email: `extra-${index}-${Date.now()}@test.scire360.com`,
          fullName: `Extra ${index}`,
          employeeCode: `EX-${index}-${Date.now()}`,
          status: "INVITED" as const,
        })),
      });

      const response = await request(crowded.app)
        .post("/api/v1/billing/checkout-session")
        .set(auth(crowded.hrAdmin.accessToken))
        .send({ tier: "STARTER", interval: "MONTHLY" })
        .expect(402);

      // Se rechaza ANTES de cobrar: cobrar y luego negar el plan es la peor
      // combinacion posible para el cliente.
      expect(response.body.error.code).toBe("EMPLOYEE_LIMIT_REACHED");
      expect(response.body.error.details.seatsUsed).toBe(12);
      expect(response.body.error.details.targetLimit).toBe(10);
    } finally {
      await crowded.cleanup();
    }
  });

  it("un EMPLOYEE no puede iniciar un cobro", async () => {
    await request(tenant.app)
      .post("/api/v1/billing/checkout-session")
      .set(auth(tenant.employee.accessToken))
      .send({ tier: "BUSINESS", interval: "MONTHLY" })
      .expect(403);
  });

  it("valida el plan destino", async () => {
    const response = await request(tenant.app)
      .post("/api/v1/billing/checkout-session")
      .set(auth(tenant.hrAdmin.accessToken))
      .send({ tier: "FREE", interval: "MONTHLY" })
      .expect(422);
    expect(response.body.error.details).toHaveProperty("tier");
  });
});

describe("guards de feature gating", () => {
  it("el plan FREE no puede exportar nomina y se le dice que plan la incluye", async () => {
    const free = await createTestTenant({ tier: SubscriptionTier.FREE });
    try {
      const today = new Date().toISOString().slice(0, 10);
      const response = await request(free.app)
        .get(`/api/v1/reports/payroll?from=${today}&to=${today}`)
        .set(auth(free.hrAdmin.accessToken))
        .expect(402);

      expect(response.body.error.code).toBe("FEATURE_NOT_IN_PLAN");
      expect(response.body.error.details.requiredTier).toBe("BUSINESS");
      expect(response.body.error.message).toContain("Business");
    } finally {
      await free.cleanup();
    }
  });

  it("el plan STARTER tampoco accede al rastro de auditoria", async () => {
    const starter = await createTestTenant({ tier: SubscriptionTier.STARTER });
    try {
      const response = await request(starter.app)
        .get("/api/v1/audit")
        .set(auth(starter.hrAdmin.accessToken))
        .expect(402);
      expect(response.body.error.details.requiredTier).toBe("BUSINESS");
    } finally {
      await starter.cleanup();
    }
  });

  it("BUSINESS si accede a nomina y auditoria", async () => {
    const today = new Date().toISOString().slice(0, 10);
    await request(tenant.app)
      .get(`/api/v1/reports/payroll?from=${today}&to=${today}`)
      .set(auth(tenant.hrAdmin.accessToken))
      .expect(200);
    await request(tenant.app)
      .get("/api/v1/audit")
      .set(auth(tenant.hrAdmin.accessToken))
      .expect(200);
  });

  it("una cuenta suspendida pierde el acceso aunque su plan incluya la funcion", async () => {
    // Se crea activa y se suspende despues: el propio login rechaza a una
    // empresa suspendida, asi que no se podria ni obtener el token.
    const suspended = await createTestTenant();
    try {
      await system.company.update({
        where: { id: suspended.companyId },
        data: { accountStatus: AccountStatus.SUSPENDED, suspendedAt: new Date() },
      });

      const response = await request(suspended.app)
        .get("/api/v1/audit")
        .set(auth(suspended.hrAdmin.accessToken))
        .expect(402);
      expect(response.body.error.code).toBe("SUBSCRIPTION_INACTIVE");
    } finally {
      await suspended.cleanup();
    }
  });
});

describe("guard de cuota de asientos", () => {
  it("bloquea el alta individual al llegar al cupo", async () => {
    const full = await createTestTenant({ maxEmployees: 3 });
    try {
      const response = await request(full.app)
        .post("/api/v1/users")
        .set(auth(full.hrAdmin.accessToken))
        .send({
          email: `cuarto-${Date.now()}@test.scire360.com`,
          fullName: "Cuarto colaborador",
          employeeCode: `C4-${Date.now()}`,
        })
        .expect(402);

      expect(response.body.error.code).toBe("EMPLOYEE_LIMIT_REACHED");
      expect(response.body.error.details).toMatchObject({ limit: 3, used: 3 });
    } finally {
      await full.cleanup();
    }
  });

  it("una invitacion masiva consume tantas plazas como personas lleve", async () => {
    // 3 usados + 5 libres: una invitacion de 6 no cabe aunque quepa una de 5.
    const limited = await createTestTenant({ maxEmployees: 8 });
    try {
      const invitations = Array.from({ length: 6 }, (_, index) => ({
        email: `masiva-${index}-${Date.now()}@test.scire360.com`,
        fullName: `Invitado ${index}`,
        employeeCode: `MI-${index}-${Date.now()}`,
      }));

      const rejected = await request(limited.app)
        .post("/api/v1/users/invite")
        .set(auth(limited.hrAdmin.accessToken))
        .send({ invitations })
        .expect(402);
      expect(rejected.body.error.details.requested).toBe(6);

      // Cinco si caben exactas.
      await request(limited.app)
        .post("/api/v1/users/invite")
        .set(auth(limited.hrAdmin.accessToken))
        .send({ invitations: invitations.slice(0, 5) })
        .expect(201);
    } finally {
      await limited.cleanup();
    }
  });

  it("un upgrade libera plazas de inmediato", async () => {
    const upgrading = await createTestTenant({ tier: SubscriptionTier.FREE, maxEmployees: 3 });
    try {
      await request(upgrading.app)
        .post("/api/v1/users")
        .set(auth(upgrading.hrAdmin.accessToken))
        .send({
          email: `bloqueado-${Date.now()}@test.scire360.com`,
          fullName: "Bloqueado",
          employeeCode: `BL-${Date.now()}`,
        })
        .expect(402);

      // Llega el cobro del plan Business.
      const reference = buildExternalReference(
        upgrading.companyId,
        SubscriptionTier.BUSINESS,
        BillingInterval.MONTHLY,
      );
      const { body } = stripeEvent({ type: "invoice.paid", externalReference: reference });
      await request(upgrading.app)
        .post("/api/v1/billing/webhook/stripe")
        .set("Content-Type", "application/json")
        .set("stripe-signature", stripeSignature(body))
        .send(body)
        .expect(200);

      await request(upgrading.app)
        .post("/api/v1/users")
        .set(auth(upgrading.hrAdmin.accessToken))
        .send({
          email: `permitido-${Date.now()}@test.scire360.com`,
          fullName: "Permitido",
          employeeCode: `PM-${Date.now()}`,
        })
        .expect(201);
    } finally {
      await upgrading.cleanup();
    }
  });
});

// Referencia usada solo para tipar; evita el aviso de import sin usar.
void PaymentProvider;
