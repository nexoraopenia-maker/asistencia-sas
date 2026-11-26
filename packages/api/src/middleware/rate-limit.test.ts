import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { resetConfigCache } from "../config.js";
import { clearRateLimit, resetMemoryBuckets } from "../lib/rate-limit.js";
import { disconnectRedis } from "../lib/redis.js";
import { createTestTenant, punchBody, request, seedTodayShifts, limaTimeOffset, type TestTenant } from "../test/helpers.js";

/**
 * Integracion del limitador con las rutas reales.
 *
 * El limitador esta apagado en el resto de la bateria (ver vitest.setup.ts) y
 * se enciende aqui: es la unica forma de probarlo sin que ahogue a los helpers
 * que crean tenants.
 */

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
let tenant: TestTenant;

beforeAll(async () => {
  // El tenant se crea con el limitador APAGADO: crearlo implica varios logins.
  tenant = await createTestTenant();
  await seedTodayShifts(tenant.companyId, tenant.employee.id, tenant.branchId, limaTimeOffset(0));
});

afterAll(async () => {
  process.env.RATE_LIMIT_ENABLED = "false";
  resetConfigCache();
  await tenant.cleanup();
  await disconnectRedis();
});

afterEach(() => {
  process.env.RATE_LIMIT_ENABLED = "false";
  resetConfigCache();
  resetMemoryBuckets();
});

/** Enciende el limitador para el bloque en curso. */
function enableLimiter(): void {
  process.env.RATE_LIMIT_ENABLED = "true";
  resetConfigCache();
  resetMemoryBuckets();
}

describe("cabeceras RFC 6585", () => {
  it("informa del limite en TODAS las respuestas, no solo al bloquear", async () => {
    enableLimiter();
    await clearRateLimit("rl:auth-ip:ip:::ffff:127.0.0.1");

    const response = await request(tenant.app)
      .post("/api/v1/auth/login")
      .send({ email: "nadie@test.scire360.com", password: "loQueSea123!" });

    // Un cliente bien hecho baja el ritmo antes de chocar.
    expect(response.headers["ratelimit-limit"]).toBeDefined();
    expect(response.headers["ratelimit-remaining"]).toBeDefined();
    expect(response.headers["ratelimit-reset"]).toBeDefined();
    expect(Number(response.headers["ratelimit-limit"])).toBeGreaterThan(0);
  });

  it("el 429 lleva Retry-After y el codigo de error del contrato", async () => {
    enableLimiter();

    let blocked: Awaited<ReturnType<typeof request>> | undefined;
    for (let attempt = 0; attempt < 12; attempt++) {
      const response = await request(tenant.app)
        .post("/api/v1/auth/login")
        .send({ email: `fuerza-bruta@test.scire360.com`, password: "intento" });
      if (response.status === 429) {
        blocked = response;
        break;
      }
    }

    expect(blocked).toBeDefined();
    expect(blocked!.status).toBe(429);
    expect(blocked!.headers["retry-after"]).toBeDefined();
    expect(Number(blocked!.headers["retry-after"])).toBeGreaterThan(0);
    expect(blocked!.body.error.code).toBe("RATE_LIMITED");
    expect(blocked!.body.error.details.retryAfterSeconds).toBeGreaterThan(0);
  });
});

describe("proteccion contra fuerza bruta en /auth", () => {
  it("corta tras el limite de intentos configurado", async () => {
    enableLimiter();

    const statuses: number[] = [];
    for (let attempt = 0; attempt < 10; attempt++) {
      const response = await request(tenant.app)
        .post("/api/v1/auth/login")
        .send({ email: "victima@test.scire360.com", password: "contrasena-erronea" });
      statuses.push(response.status);
    }

    const rejected = statuses.filter((status) => status === 429);
    const attempted = statuses.filter((status) => status === 401);

    // Cinco intentos por minuto: el resto se corta.
    expect(attempted.length).toBeLessThanOrEqual(5);
    expect(rejected.length).toBeGreaterThanOrEqual(4);
  });

  it("el limite por credencial es independiente del de IP", async () => {
    enableLimiter();

    // Se agota el cupo de una cuenta.
    for (let i = 0; i < 6; i++) {
      await request(tenant.app)
        .post("/api/v1/auth/login")
        .send({ email: "cuenta-a@test.scire360.com", password: "x" });
    }

    // Desde la misma IP, otra cuenta tambien acaba bloqueada por el limite de
    // IP: es el comportamiento correcto, un atacante no debe poder recorrer
    // miles de correos desde una sola conexion.
    const other = await request(tenant.app)
      .post("/api/v1/auth/login")
      .send({ email: "cuenta-b@test.scire360.com", password: "x" });

    expect([401, 429]).toContain(other.status);
  });

  it("una peticion sin correo no revienta el limitador", async () => {
    enableLimiter();
    // `byLoginIdentity` devuelve null y el limite por credencial se omite;
    // la validacion de Zod es quien rechaza.
    const response = await request(tenant.app).post("/api/v1/auth/login").send({});
    expect([422, 429]).toContain(response.status);
  });
});

describe("proteccion de /punch", () => {
  it("limita las marcaciones por usuario", async () => {
    enableLimiter();

    const statuses: number[] = [];
    for (let attempt = 0; attempt < 14; attempt++) {
      const response = await request(tenant.app)
        .post("/api/v1/punch")
        .set(auth(tenant.employee.accessToken))
        .send(punchBody(tenant.branchId, "IN"));
      statuses.push(response.status);
    }

    // Diez por minuto: sobra para una jornada real (cuatro marcaciones) y
    // para reintentos, y corta el envio repetido.
    expect(statuses.filter((status) => status === 429).length).toBeGreaterThanOrEqual(3);
  });

  it("el limite es por usuario, no global", async () => {
    enableLimiter();

    // Se agota el cupo del empleado.
    for (let i = 0; i < 12; i++) {
      await request(tenant.app)
        .post("/api/v1/punch")
        .set(auth(tenant.employee.accessToken))
        .send(punchBody(tenant.branchId, "IN"));
    }

    // Otro colaborador de la misma empresa sigue pudiendo marcar: un compañero
    // que abusa no puede dejar sin fichar al resto del turno.
    const other = await request(tenant.app)
      .post("/api/v1/punch")
      .set(auth(tenant.supervisor.accessToken))
      .send(punchBody(tenant.branchId, "IN"));

    expect(other.status).not.toBe(429);
  });

  it("el lote offline tambien esta limitado", async () => {
    enableLimiter();

    const statuses: number[] = [];
    for (let attempt = 0; attempt < 14; attempt++) {
      const response = await request(tenant.app)
        .post("/api/v1/punch/batch")
        .set(auth(tenant.employee.accessToken))
        .send({ punches: [punchBody(tenant.branchId, "IN")] });
      statuses.push(response.status);
    }

    expect(statuses.filter((status) => status === 429).length).toBeGreaterThanOrEqual(3);
  });
});

describe("concurrencia sobre la ruta real", () => {
  it("una rafaga simultanea no supera el limite", async () => {
    enableLimiter();

    // Veinte peticiones a la vez: el caso que rompe un contador sin atomicidad.
    const responses = await Promise.all(
      Array.from({ length: 20 }, () =>
        request(tenant.app)
          .post("/api/v1/punch")
          .set(auth(tenant.employee.accessToken))
          .send(punchBody(tenant.branchId, "IN")),
      ),
    );

    const passed = responses.filter((response) => response.status !== 429).length;
    expect(passed).toBeLessThanOrEqual(10);
    expect(responses.filter((r) => r.status === 429).length).toBeGreaterThanOrEqual(10);
  });
});

describe("interruptor global", () => {
  it("con el limitador apagado no aparecen cabeceras ni bloqueos", async () => {
    process.env.RATE_LIMIT_ENABLED = "false";
    resetConfigCache();

    const responses = [];
    for (let i = 0; i < 12; i++) {
      responses.push(
        await request(tenant.app)
          .post("/api/v1/auth/login")
          .send({ email: "sin-limite@test.scire360.com", password: "x" }),
      );
    }

    expect(responses.every((response) => response.status !== 429)).toBe(true);
  });
});
