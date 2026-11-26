import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createTestTenant,
  request,
  system,
  TEST_PASSWORD,
  type TestTenant,
} from "../../test/helpers.js";

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

/** Tenant del operador: aloja al SUPER_ADMIN. */
let platform: TestTenant;
/** Cliente al que se suspende y reactiva. */
let customer: TestTenant;
let superAdminToken: string;
const createdCompanyIds: string[] = [];

beforeAll(async () => {
  platform = await createTestTenant();
  customer = await createTestTenant();

  const superAdmin = await system.user.create({
    data: {
      companyId: platform.companyId,
      email: `super-${randomUUID().slice(0, 8)}@test.scire360.com`,
      passwordHash: await bcrypt.hash(TEST_PASSWORD, 10),
      fullName: "Operador de plataforma",
      employeeCode: `SA-${randomUUID().slice(0, 8)}`,
      role: "SUPER_ADMIN",
      status: "ACTIVE",
    },
  });

  const login = await request(platform.app)
    .post("/api/v1/auth/login")
    .send({ email: superAdmin.email, password: TEST_PASSWORD })
    .expect(200);
  superAdminToken = login.body.data.tokens.accessToken;
});

afterAll(async () => {
  for (const id of createdCompanyIds) {
    await system.company.delete({ where: { id } }).catch(() => {});
  }
  await customer.cleanup();
  await platform.cleanup();
});

describe("consola de plataforma: acceso", () => {
  it("rechaza a un HR_ADMIN de tenant", async () => {
    const response = await request(customer.app)
      .get("/api/v1/platform/tenants")
      .set(auth(customer.hrAdmin.accessToken))
      .expect(403);
    expect(response.body.error.code).toBe("FORBIDDEN");
  });

  it("rechaza peticiones sin token", async () => {
    await request(customer.app).get("/api/v1/platform/tenants").expect(401);
  });
});

describe("consola de plataforma: listado", () => {
  it("ve empresas de todos los tenants, no solo la suya", async () => {
    const response = await request(platform.app)
      .get(`/api/v1/platform/tenants?search=${encodeURIComponent("Test Co")}&pageSize=100`)
      .set(auth(superAdminToken))
      .expect(200);

    const ids = response.body.data.items.map((item: { id: string }) => item.id);
    expect(ids).toContain(customer.companyId);
    expect(ids).toContain(platform.companyId);
    expect(response.body.data.totals.ACTIVE).toBeGreaterThanOrEqual(2);
  });
});

describe("consola de plataforma: alta de empresa", () => {
  it("crea empresa, suscripcion y HR_ADMIN con el plan elegido", async () => {
    const email = `nuevo-${randomUUID().slice(0, 8)}@test.scire360.com`;
    const response = await request(platform.app)
      .post("/api/v1/platform/tenants")
      .set(auth(superAdminToken))
      .send({
        companyName: `Cliente Manual ${randomUUID().slice(0, 6)}`,
        tier: "STARTER",
        adminFullName: "Admin Inicial",
        adminEmail: email,
      })
      .expect(201);

    const { tenant, temporaryPassword } = response.body.data;
    createdCompanyIds.push(tenant.id);

    expect(tenant.tier).toBe("STARTER");
    expect(tenant.maxEmployees).toBe(10);
    expect(tenant.accountStatus).toBe("ACTIVE");
    expect(tenant.graceEndsAt).toBeNull();
    expect(tenant.admin.email).toBe(email);
    expect(typeof temporaryPassword).toBe("string");

    // El administrador puede entrar con la contrasena temporal.
    const login = await request(platform.app)
      .post("/api/v1/auth/login")
      .send({ email, password: temporaryPassword })
      .expect(200);
    expect(login.body.data.user.role).toBe("HR_ADMIN");

    const audit = await system.auditLog.findFirst({
      where: { companyId: tenant.id, entityType: "Company", action: "CREATE" },
    });
    expect(audit).not.toBeNull();
  });

  it("no duplica un correo ya registrado", async () => {
    const response = await request(platform.app)
      .post("/api/v1/platform/tenants")
      .set(auth(superAdminToken))
      .send({
        companyName: "Duplicada",
        tier: "FREE",
        adminFullName: "Otro Admin",
        adminEmail: customer.hrAdmin.email,
      })
      .expect(409);
    expect(response.body.error.code).toBe("CONFLICT");
  });
});

describe("consola de plataforma: suspension manual", () => {
  it("suspende, corta las sesiones y bloquea el login", async () => {
    const response = await request(platform.app)
      .patch(`/api/v1/platform/tenants/${customer.companyId}/status`)
      .set(auth(superAdminToken))
      .send({ status: "SUSPENDED", reason: "Impago acordado fuera de la pasarela" })
      .expect(200);
    expect(response.body.data.accountStatus).toBe("SUSPENDED");

    // El token emitido antes de la suspension deja de servir.
    await request(customer.app)
      .get("/api/v1/users")
      .set(auth(customer.hrAdmin.accessToken))
      .expect(401);

    const login = await request(customer.app)
      .post("/api/v1/auth/login")
      .send({ email: customer.hrAdmin.email, password: TEST_PASSWORD })
      .expect(402);
    expect(login.body.error.code).toBe("SUBSCRIPTION_INACTIVE");
  });

  it("reactiva y el login vuelve a funcionar", async () => {
    const response = await request(platform.app)
      .patch(`/api/v1/platform/tenants/${customer.companyId}/status`)
      .set(auth(superAdminToken))
      .send({ status: "ACTIVE", reason: "Pago recibido por transferencia" })
      .expect(200);
    expect(response.body.data.accountStatus).toBe("ACTIVE");
    expect(response.body.data.suspendedAt).toBeNull();

    await request(customer.app)
      .post("/api/v1/auth/login")
      .send({ email: customer.hrAdmin.email, password: TEST_PASSWORD })
      .expect(200);

    const entries = await system.auditLog.count({
      where: { companyId: customer.companyId, entityType: "Company", action: "UPDATE" },
    });
    expect(entries).toBe(2);
  });

  it("exige motivo", async () => {
    await request(platform.app)
      .patch(`/api/v1/platform/tenants/${customer.companyId}/status`)
      .set(auth(superAdminToken))
      .send({ status: "SUSPENDED" })
      .expect(422);
  });

  it("no deja al operador suspender su propia empresa", async () => {
    const response = await request(platform.app)
      .patch(`/api/v1/platform/tenants/${platform.companyId}/status`)
      .set(auth(superAdminToken))
      .send({ status: "SUSPENDED", reason: "Prueba" })
      .expect(403);
    expect(response.body.error.code).toBe("FORBIDDEN");
  });
});
