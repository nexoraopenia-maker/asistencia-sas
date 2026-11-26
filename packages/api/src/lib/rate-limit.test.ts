import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  clearRateLimit,
  consumeRateLimit,
  peekRateLimit,
  resetMemoryBuckets,
} from "./rate-limit.js";
import { disconnectRedis, isRedisReady } from "./redis.js";

/**
 * Tests del limitador.
 *
 * Corren contra el Redis real si esta disponible y contra el respaldo en
 * memoria si no. Ambos caminos deben comportarse igual: probar solo uno
 * dejaria sin cubrir justo la ruta que se usa cuando algo va mal.
 */

const rule = { limit: 5, windowSeconds: 60 };
let keySeq = 0;
const nextKey = () => `rl:test:${Date.now()}-${keySeq++}`;

beforeEach(() => {
  resetMemoryBuckets();
});

afterAll(async () => {
  await disconnectRedis();
});

describe("ventana deslizante", () => {
  it("deja pasar hasta el limite y bloquea el siguiente", async () => {
    const key = nextKey();

    for (let attempt = 1; attempt <= rule.limit; attempt++) {
      const result = await consumeRateLimit(key, rule);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(rule.limit - attempt);
    }

    const blocked = await consumeRateLimit(key, rule);
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
    expect(blocked.retryAfterSeconds).toBeLessThanOrEqual(rule.windowSeconds);

    await clearRateLimit(key);
  });

  it("una peticion rechazada no ocupa sitio en la ventana", async () => {
    const key = nextKey();
    for (let i = 0; i < rule.limit; i++) await consumeRateLimit(key, rule);

    // Un cliente que insiste no debe auto-prolongarse el bloqueo.
    for (let i = 0; i < 20; i++) await consumeRateLimit(key, rule);

    expect(await peekRateLimit(key, rule)).toBe(rule.limit);
    await clearRateLimit(key);
  });

  it("las claves son independientes entre si", async () => {
    const a = nextKey();
    const b = nextKey();

    for (let i = 0; i < rule.limit; i++) await consumeRateLimit(a, rule);
    expect((await consumeRateLimit(a, rule)).allowed).toBe(false);
    // Bloquear una IP no puede bloquear a las demas.
    expect((await consumeRateLimit(b, rule)).allowed).toBe(true);

    await Promise.all([clearRateLimit(a), clearRateLimit(b)]);
  });

  it("la ventana se libera al expirar", async () => {
    const key = nextKey();
    const shortRule = { limit: 2, windowSeconds: 1 };

    expect((await consumeRateLimit(key, shortRule)).allowed).toBe(true);
    expect((await consumeRateLimit(key, shortRule)).allowed).toBe(true);
    expect((await consumeRateLimit(key, shortRule)).allowed).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect((await consumeRateLimit(key, shortRule)).allowed).toBe(true);

    await clearRateLimit(key);
  });

  it("clearRateLimit libera el contador de inmediato", async () => {
    const key = nextKey();
    for (let i = 0; i < rule.limit; i++) await consumeRateLimit(key, rule);
    expect((await consumeRateLimit(key, rule)).allowed).toBe(false);

    // Es lo que se hace tras un login correcto: los intentos fallidos previos
    // no deben penalizar a quien ya demostro ser quien dice.
    await clearRateLimit(key);
    expect((await consumeRateLimit(key, rule)).allowed).toBe(true);

    await clearRateLimit(key);
  });
});

describe("concurrencia", () => {
  it("veinte peticiones simultaneas dejan pasar exactamente el limite", async () => {
    const key = nextKey();

    // El caso que rompe un contador ingenuo: sin atomicidad, varias lecturas
    // ven el mismo recuento y pasan de mas.
    const results = await Promise.all(
      Array.from({ length: 20 }, () => consumeRateLimit(key, rule)),
    );

    const allowed = results.filter((result) => result.allowed).length;
    expect(allowed).toBe(rule.limit);
    expect(results.filter((result) => !result.allowed)).toHaveLength(15);

    await clearRateLimit(key);
  });

  it("dos rafagas concurrentes sobre claves distintas no interfieren", async () => {
    const a = nextKey();
    const b = nextKey();

    const [resultsA, resultsB] = await Promise.all([
      Promise.all(Array.from({ length: 10 }, () => consumeRateLimit(a, rule))),
      Promise.all(Array.from({ length: 10 }, () => consumeRateLimit(b, rule))),
    ]);

    expect(resultsA.filter((r) => r.allowed)).toHaveLength(rule.limit);
    expect(resultsB.filter((r) => r.allowed)).toHaveLength(rule.limit);

    await Promise.all([clearRateLimit(a), clearRateLimit(b)]);
  });
});

describe("respaldo en memoria", () => {
  it("aplica el mismo limite que Redis", async () => {
    // Se fuerza el camino en memoria usando una clave que nunca toca Redis:
    // si Redis esta caido, `consumeRateLimit` ya cae aqui solo.
    resetMemoryBuckets();
    const key = `memoria-${Date.now()}`;

    const results = [];
    for (let i = 0; i < 8; i++) results.push(await consumeRateLimit(key, rule));

    // Con Redis activo el resultado es el mismo; lo que se comprueba es que el
    // limite se respeta venga de donde venga.
    expect(results.filter((r) => r.allowed)).toHaveLength(rule.limit);
    await clearRateLimit(key);
  });

  it("informa de si el conteo fue distribuido", async () => {
    const key = nextKey();
    const result = await consumeRateLimit(key, rule);
    // En este entorno Redis esta arriba; si no lo estuviera, el respaldo lo
    // diria con `distributed: false` en vez de fingir que si.
    expect(result.distributed).toBe(isRedisReady());
    await clearRateLimit(key);
  });
});
