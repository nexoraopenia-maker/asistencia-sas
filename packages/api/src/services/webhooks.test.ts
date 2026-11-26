import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createTestTenant,
  punchBody,
  request,
  seedTodayShifts,
  system,
  type TestTenant,
} from "../test/helpers.js";
import { dispatchPending, signPayload, verifySignature, WebhookEvent } from "./webhooks.service.js";

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

describe("firma HMAC", () => {
  const secret = "un-secreto-compartido-de-prueba";
  const body = JSON.stringify({ event: "punch.late", data: { minutes: 12 } });

  it("una firma valida se verifica", () => {
    const timestamp = Math.floor(Date.now() / 1000);
    expect(verifySignature(secret, body, signPayload(secret, body, timestamp))).toBe(true);
  });

  it("rechaza la firma si el cuerpo fue alterado", () => {
    const timestamp = Math.floor(Date.now() / 1000);
    const header = signPayload(secret, body, timestamp);
    expect(verifySignature(secret, `${body} `, header)).toBe(false);
  });

  it("rechaza la firma hecha con otro secreto", () => {
    const timestamp = Math.floor(Date.now() / 1000);
    expect(verifySignature(secret, body, signPayload("otro-secreto", body, timestamp))).toBe(false);
  });

  it("rechaza un reenvio antiguo: el timestamp entra en la firma", () => {
    const old = Math.floor(Date.now() / 1000) - 3600;
    expect(verifySignature(secret, body, signPayload(secret, body, old))).toBe(false);
  });
});

describe("outbox de eventos", () => {
  let tenant: TestTenant;
  let received: { headers: Record<string, string | string[] | undefined>; body: string }[] = [];
  let server: Server;
  let endpointUrl: string;
  const secret = randomUUID().replace(/-/g, "");

  beforeAll(async () => {
    // Receptor local que hace de n8n.
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        received.push({ headers: req.headers, body });
        res.writeHead(200).end("ok");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    endpointUrl = `http://127.0.0.1:${port}/webhook`;

    tenant = await createTestTenant();
    await seedTodayShifts(tenant.companyId, tenant.employee.id, tenant.branchId);
    await system.webhookEndpoint.create({
      data: {
        companyId: tenant.companyId,
        name: "n8n de prueba",
        url: endpointUrl,
        secret,
        events: [
          WebhookEvent.PUNCH_CREATED,
          WebhookEvent.PUNCH_MOCK_LOCATION,
          WebhookEvent.PUNCH_LATE,
        ],
        isActive: true,
      },
    });
  });

  afterAll(async () => {
    await tenant.cleanup();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("una marcacion con GPS simulado encola punch.created y punch.mock_location", async () => {
    await request(tenant.app)
      .post("/api/v1/punch")
      .set(auth(tenant.employee.accessToken))
      .send(
        punchBody(tenant.branchId, "IN", {
          location: {
            latitude: -12.046374,
            longitude: -77.042793,
            accuracyMeters: 10,
            isMockLocation: true,
          },
        }),
      )
      .expect(201);

    const queued = await system.webhookDelivery.findMany({
      where: { companyId: tenant.companyId },
      select: { eventType: true, deliveredAt: true },
    });

    const types = queued.map((d) => d.eventType).sort();
    expect(types).toContain(WebhookEvent.PUNCH_CREATED);
    expect(types).toContain(WebhookEvent.PUNCH_MOCK_LOCATION);
    // Todavia sin entregar: el outbox desacopla la marcacion de la notificacion.
    expect(queued.every((d) => d.deliveredAt === null)).toBe(true);
  });

  it("el despachador entrega las pendientes firmadas y las marca como entregadas", async () => {
    received = [];
    const result = await dispatchPending();

    expect(result.delivered).toBeGreaterThanOrEqual(2);
    expect(received.length).toBeGreaterThanOrEqual(2);

    const delivery = received[0]!;
    expect(delivery.headers["x-scire-event"]).toBeTruthy();
    // El receptor puede verificar la firma con el secreto compartido.
    expect(
      verifySignature(secret, delivery.body, delivery.headers["x-scire-signature"] as string),
    ).toBe(true);

    const payload = JSON.parse(delivery.body);
    expect(payload).toHaveProperty("event");
    expect(payload).toHaveProperty("occurredAt");
    expect(payload.data).toHaveProperty("recordId");

    const pending = await system.webhookDelivery.count({
      where: { companyId: tenant.companyId, deliveredAt: null },
    });
    expect(pending).toBe(0);
  });

  it("no reenvia lo ya entregado", async () => {
    received = [];
    const result = await dispatchPending();
    expect(result.processed).toBe(0);
    expect(received).toHaveLength(0);
  });

  it("un endpoint caido reprograma el reintento con backoff, sin perder el evento", async () => {
    const broken = await createTestTenant();
    try {
      await seedTodayShifts(broken.companyId, broken.employee.id, broken.branchId);
      await system.webhookEndpoint.create({
        data: {
          companyId: broken.companyId,
          name: "endpoint caido",
          // Puerto cerrado a proposito.
          url: "http://127.0.0.1:9/no-existe",
          secret: "x".repeat(32),
          events: [WebhookEvent.PUNCH_CREATED],
          isActive: true,
        },
      });

      await request(broken.app)
        .post("/api/v1/punch")
        .set(auth(broken.employee.accessToken))
        .send(punchBody(broken.branchId, "IN"))
        .expect(201);

      const result = await dispatchPending();
      expect(result.failed).toBeGreaterThanOrEqual(1);

      const delivery = await system.webhookDelivery.findFirstOrThrow({
        where: { companyId: broken.companyId },
      });
      expect(delivery.deliveredAt).toBeNull();
      expect(delivery.attempts).toBe(1);
      expect(delivery.error).toBeTruthy();
      // Queda reprogramado en el futuro: el evento no se pierde.
      expect(delivery.nextRetryAt!.getTime()).toBeGreaterThan(Date.now());
    } finally {
      await broken.cleanup();
    }
  });

  it("una empresa sin endpoints configurados no encola nada", async () => {
    const quiet = await createTestTenant();
    try {
      await seedTodayShifts(quiet.companyId, quiet.employee.id, quiet.branchId);
      await request(quiet.app)
        .post("/api/v1/punch")
        .set(auth(quiet.employee.accessToken))
        .send(punchBody(quiet.branchId, "IN"))
        .expect(201);

      const count = await system.webhookDelivery.count({ where: { companyId: quiet.companyId } });
      expect(count).toBe(0);
    } finally {
      await quiet.cleanup();
    }
  });
});
