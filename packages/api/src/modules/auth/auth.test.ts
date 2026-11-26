import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createTestTenant,
  request,
  system,
  TEST_PASSWORD,
  type TestTenant,
} from "../../test/helpers.js";

let tenant: TestTenant;

beforeAll(async () => {
  tenant = await createTestTenant();
});

afterAll(async () => {
  await tenant.cleanup();
});

describe("login", () => {
  it("devuelve el perfil y el par de tokens", async () => {
    const response = await request(tenant.app)
      .post("/api/v1/auth/login")
      .send({ email: tenant.employee.email, password: TEST_PASSWORD })
      .expect(200);

    expect(response.body.success).toBe(true);
    expect(response.body.data.tokens.accessToken).toBeTruthy();
    expect(response.body.data.tokens.refreshToken).toBeTruthy();
    expect(response.body.data.tokens.tokenType).toBe("Bearer");
    expect(response.body.data.user.companyId).toBe(tenant.companyId);
  });

  it("rechaza una contrasena incorrecta sin revelar si el correo existe", async () => {
    const wrongPassword = await request(tenant.app)
      .post("/api/v1/auth/login")
      .send({ email: tenant.employee.email, password: "OtraCosa123!" })
      .expect(401);

    const unknownEmail = await request(tenant.app)
      .post("/api/v1/auth/login")
      .send({ email: "no-existe@test.scire360.com", password: "OtraCosa123!" })
      .expect(401);

    // Mismo codigo y mismo mensaje en ambos casos: la respuesta no distingue
    // "no existe" de "contrasena mala".
    expect(wrongPassword.body.error.code).toBe("INVALID_CREDENTIALS");
    expect(unknownEmail.body.error.code).toBe("INVALID_CREDENTIALS");
    expect(unknownEmail.body.error.message).toBe(wrongPassword.body.error.message);
  });

  it("valida el formato del cuerpo con detalle por campo", async () => {
    const response = await request(tenant.app)
      .post("/api/v1/auth/login")
      .send({ email: "no-es-un-email", password: "" })
      .expect(422);

    expect(response.body.error.code).toBe("VALIDATION_ERROR");
    expect(response.body.error.details).toHaveProperty("email");
    expect(response.body.error.details).toHaveProperty("password");
  });
});

describe("rotacion de refresh tokens", () => {
  it("emite un par nuevo e invalida el token usado", async () => {
    const login = await request(tenant.app)
      .post("/api/v1/auth/login")
      .send({ email: tenant.supervisor.email, password: TEST_PASSWORD })
      .expect(200);

    const first = login.body.data.tokens.refreshToken as string;

    const refreshed = await request(tenant.app)
      .post("/api/v1/auth/refresh")
      .send({ refreshToken: first })
      .expect(200);

    const second = refreshed.body.data.refreshToken as string;
    expect(second).not.toBe(first);

    // El nuevo funciona...
    await request(tenant.app).post("/api/v1/auth/refresh").send({ refreshToken: second }).expect(200);
  });

  // Tenant propio: la deteccion revoca TODAS las sesiones del usuario, asi que
  // reutilizar el del resto de la suite invalidaria tokens que otros tests usan.
  it("revoca TODAS las sesiones al detectar la reutilizacion de un token", async () => {
    const victim = await createTestTenant();
    try {
      const login = await request(victim.app)
        .post("/api/v1/auth/login")
        .send({ email: victim.hrAdmin.email, password: TEST_PASSWORD })
        .expect(200);

      const original = login.body.data.tokens.refreshToken as string;
      const access = login.body.data.tokens.accessToken as string;

      // Rotacion normal.
      await request(victim.app)
        .post("/api/v1/auth/refresh")
        .send({ refreshToken: original })
        .expect(200);

      // Reutilizacion del token ya rotado: senal de robo.
      const reuse = await request(victim.app)
        .post("/api/v1/auth/refresh")
        .send({ refreshToken: original })
        .expect(401);
      expect(reuse.body.error.code).toBe("TOKEN_REVOKED");

      // Y como no se puede saber quien es el atacante, cae toda la cadena:
      // incluso el access token que seguia siendo criptograficamente valido,
      // y tambien la sesion inicial que no participo en la rotacion.
      const afterBreach = await request(victim.app)
        .get("/api/v1/auth/me")
        .set("Authorization", `Bearer ${access}`)
        .expect(401);
      expect(afterBreach.body.error.code).toBe("TOKEN_REVOKED");

      await request(victim.app)
        .get("/api/v1/auth/me")
        .set("Authorization", `Bearer ${victim.hrAdmin.accessToken}`)
        .expect(401);

      // Se deja constancia en el rastro de auditoria.
      const entry = await system.auditLog.findFirst({
        where: { companyId: victim.companyId, entityType: "Session", action: "DELETE" },
      });
      expect(entry?.reason).toContain("Reutilizacion de refresh token");
    } finally {
      await victim.cleanup();
    }
  });
});

describe("proteccion de endpoints", () => {
  it("exige la cabecera Authorization", async () => {
    const response = await request(tenant.app).get("/api/v1/punch/today").expect(401);
    expect(response.body.error.code).toBe("UNAUTHENTICATED");
  });

  it("rechaza un token con firma invalida", async () => {
    const response = await request(tenant.app)
      .get("/api/v1/auth/me")
      .set("Authorization", "Bearer no.es.un.token")
      .expect(401);
    expect(response.body.error.code).toBe("UNAUTHENTICATED");
  });

  it("un refresh token no sirve como access token", async () => {
    await request(tenant.app)
      .get("/api/v1/auth/me")
      .set("Authorization", `Bearer ${tenant.employee.refreshToken}`)
      .expect(401);
  });

  it("bloquea al instante a un empleado dado de baja, sin esperar a que expire su token", async () => {
    const victim = await createTestTenant();
    try {
      await request(victim.app)
        .get("/api/v1/auth/me")
        .set("Authorization", `Bearer ${victim.employee.accessToken}`)
        .expect(200);

      await system.user.update({
        where: { id: victim.employee.id },
        data: { status: "TERMINATED" },
      });

      const response = await request(victim.app)
        .get("/api/v1/auth/me")
        .set("Authorization", `Bearer ${victim.employee.accessToken}`)
        .expect(403);
      expect(response.body.error.code).toBe("USER_SUSPENDED");
    } finally {
      await victim.cleanup();
    }
  });

  it("logout revoca la sesion del dispositivo", async () => {
    const login = await request(tenant.app)
      .post("/api/v1/auth/login")
      .send({ email: tenant.employee.email, password: TEST_PASSWORD, deviceId: "device-x" })
      .expect(200);

    const { accessToken, refreshToken } = login.body.data.tokens;

    await request(tenant.app).post("/api/v1/auth/logout").send({ refreshToken }).expect(200);

    const after = await request(tenant.app)
      .get("/api/v1/auth/me")
      .set("Authorization", `Bearer ${accessToken}`)
      .expect(401);
    expect(after.body.error.code).toBe("TOKEN_REVOKED");
  });
});

describe("RBAC", () => {
  it("un EMPLOYEE no puede consultar el rastro de auditoria", async () => {
    const response = await request(tenant.app)
      .get("/api/v1/audit")
      .set("Authorization", `Bearer ${tenant.employee.accessToken}`)
      .expect(403);
    expect(response.body.error.code).toBe("FORBIDDEN");
  });

  it("un SUPERVISOR tampoco: la auditoria es de HR_ADMIN para arriba", async () => {
    await request(tenant.app)
      .get("/api/v1/audit")
      .set("Authorization", `Bearer ${tenant.supervisor.accessToken}`)
      .expect(403);
  });

  it("un HR_ADMIN si", async () => {
    await request(tenant.app)
      .get("/api/v1/audit")
      .set("Authorization", `Bearer ${tenant.hrAdmin.accessToken}`)
      .expect(200);
  });
});

describe("registro de empresa", () => {
  it("crea empresa, suscripcion en trial y administrador en una sola operacion", async () => {
    const email = `founder-${Date.now()}@test.scire360.com`;
    const response = await request(tenant.app)
      .post("/api/v1/auth/register-company")
      .send({
        companyName: "Panaderia El Amanecer",
        timezone: "America/Lima",
        adminFullName: "Ana Torres",
        adminEmail: email,
        adminPassword: "Panaderia2026!",
        acceptedTerms: true,
      })
      .expect(201);

    const companyId = response.body.data.user.companyId as string;
    try {
      expect(response.body.data.user.role).toBe("HR_ADMIN");
      expect(response.body.data.tokens.accessToken).toBeTruthy();

      const subscription = await system.subscription.findUnique({ where: { companyId } });
      expect(subscription?.status).toBe("TRIALING");
      expect(subscription?.trialEndsAt).toBeInstanceOf(Date);
    } finally {
      await system.company.delete({ where: { id: companyId } });
    }
  });

  it("no permite dos cuentas con el mismo correo", async () => {
    const response = await request(tenant.app)
      .post("/api/v1/auth/register-company")
      .send({
        companyName: "Otra Empresa",
        adminFullName: "Repetido",
        adminEmail: tenant.hrAdmin.email,
        adminPassword: "Repetido2026!",
        acceptedTerms: true,
      })
      .expect(409);
    expect(response.body.error.code).toBe("CONFLICT");
  });
});
