import { awaitRedisReady, getRedis } from "./redis.js";

/**
 * Limitador de peticiones con ventana deslizante.
 *
 * Se usa ventana deslizante y no ventana fija porque la fija tiene un agujero
 * conocido: con un limite de 5 por minuto, un atacante puede hacer 5 peticiones
 * a las 12:00:59 y otras 5 a las 12:01:00 — 10 en dos segundos. La deslizante
 * cuenta siempre los ultimos N segundos reales.
 *
 * La implementacion en Redis usa un sorted set por clave: cada peticion es un
 * miembro con el timestamp como score. Contar es un `ZCARD` tras purgar lo
 * viejo con `ZREMRANGEBYSCORE`, y todo va en un `MULTI` para que sea atomico
 * entre procesos.
 */

export interface RateLimitRule {
  /** Peticiones permitidas dentro de la ventana. */
  limit: number;
  /** Tamano de la ventana en segundos. */
  windowSeconds: number;
}

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Segundos hasta que se libere un hueco. */
  retryAfterSeconds: number;
  /** Instante en que la ventana vuelve a estar limpia. */
  resetAt: Date;
  /** `false` cuando se resolvio con el respaldo en memoria. */
  distributed: boolean;
}

// -----------------------------------------------------------------------------
// Respaldo en memoria
// -----------------------------------------------------------------------------

/**
 * Se activa cuando Redis no esta disponible.
 *
 * Es un respaldo real, no un "dejar pasar todo": ante una caida de Redis, un
 * limitador que se abre convierte un incidente de infraestructura en una
 * ventana de fuerza bruta. Cuenta por proceso, asi que con N instancias el
 * limite efectivo es N veces mayor — degradado pero muy lejos de ilimitado.
 */
const memoryBuckets = new Map<string, number[]>();
let lastSweep = Date.now();

/** Purga periodica: sin ella el mapa crece con cada IP que pasa por la API. */
function sweepMemory(now: number, windowMs: number): void {
  if (now - lastSweep < 60_000) return;
  lastSweep = now;
  for (const [key, hits] of memoryBuckets) {
    const alive = hits.filter((hit) => hit > now - windowMs);
    if (alive.length === 0) memoryBuckets.delete(key);
    else memoryBuckets.set(key, alive);
  }
}

function consumeInMemory(key: string, rule: RateLimitRule): RateLimitResult {
  const now = Date.now();
  const windowMs = rule.windowSeconds * 1_000;
  sweepMemory(now, windowMs);

  const hits = (memoryBuckets.get(key) ?? []).filter((hit) => hit > now - windowMs);
  const allowed = hits.length < rule.limit;
  if (allowed) hits.push(now);
  memoryBuckets.set(key, hits);

  const oldest = hits[0] ?? now;
  const resetAt = new Date(oldest + windowMs);

  return {
    allowed,
    limit: rule.limit,
    remaining: Math.max(0, rule.limit - hits.length),
    retryAfterSeconds: allowed ? 0 : Math.max(1, Math.ceil((resetAt.getTime() - now) / 1_000)),
    resetAt,
    distributed: false,
  };
}

/** Solo para tests: vacia los contadores en memoria. */
export function resetMemoryBuckets(): void {
  memoryBuckets.clear();
}

// -----------------------------------------------------------------------------
// Ventana deslizante en Redis
// -----------------------------------------------------------------------------

async function consumeInRedis(key: string, rule: RateLimitRule): Promise<RateLimitResult | null> {
  // Espera breve a que la conexion este lista: recien arrancado el proceso, el
  // cliente esta en "connecting" y devolver null aqui haria que las primeras
  // peticiones se contaran solo en memoria.
  const redis = await awaitRedisReady();
  if (!redis) return null;

  const now = Date.now();
  const windowMs = rule.windowSeconds * 1_000;
  const cutoff = now - windowMs;
  // Miembro unico por peticion: dos llegadas en el mismo milisegundo tienen
  // que contar como dos, y un sorted set descarta miembros repetidos.
  const member = `${now}-${Math.random().toString(36).slice(2, 10)}`;

  try {
    // Purgar + registrar + contar van en un MULTI para que sea atomico entre
    // procesos: sin el, dos instancias podrian leer el mismo recuento y dejar
    // pasar el doble de peticiones.
    const results = await redis
      .multi()
      .zremrangebyscore(key, 0, cutoff)
      .zadd(key, String(now), member)
      .zcard(key)
      // La clave caduca sola: no hace falta limpiar claves de IPs que no
      // vuelven, que serian millones en una API publica.
      .pexpire(key, windowMs + 1_000)
      .exec();

    if (!results) return null;

    const count = Number(results[2]?.[1] ?? 0);

    // El instante de la entrada mas antigua marca cuando se libera un hueco.
    // Va fuera del MULTI porque solo se usa para informar al cliente: si
    // fallara, el limite ya esta decidido.
    const oldestEntry = (await redis
      .zrange(key, 0, "0", "WITHSCORES")
      .catch(() => [] as string[])) as string[];
    const oldest = Number(oldestEntry[1] ?? now);

    const allowed = count <= rule.limit;
    if (!allowed) {
      // La peticion rechazada no debe ocupar sitio en la ventana: si contara,
      // un cliente que insiste se auto-prolongaria el bloqueo indefinidamente.
      await redis.zrem(key, member);
    }

    const resetAt = new Date(oldest + windowMs);
    return {
      allowed,
      limit: rule.limit,
      remaining: Math.max(0, rule.limit - Math.min(count, rule.limit)),
      retryAfterSeconds: allowed ? 0 : Math.max(1, Math.ceil((resetAt.getTime() - now) / 1_000)),
      resetAt,
      distributed: true,
    };
  } catch {
    return null;
  }
}

/**
 * Consume una unidad del limite para `key`.
 *
 * Intenta Redis y cae a memoria si no esta disponible. Nunca lanza: un fallo
 * del limitador no puede tumbar la peticion que estaba protegiendo.
 */
export async function consumeRateLimit(
  key: string,
  rule: RateLimitRule,
): Promise<RateLimitResult> {
  const distributed = await consumeInRedis(key, rule);
  return distributed ?? consumeInMemory(key, rule);
}

/** Consulta sin consumir. Util para tests y diagnostico. */
export async function peekRateLimit(key: string, rule: RateLimitRule): Promise<number> {
  const redis = getRedis();
  if (redis && redis.status === "ready") {
    const now = Date.now();
    await redis.zremrangebyscore(key, 0, now - rule.windowSeconds * 1_000).catch(() => 0);
    return (await redis.zcard(key).catch(() => 0)) as number;
  }
  const windowMs = rule.windowSeconds * 1_000;
  const now = Date.now();
  return (memoryBuckets.get(key) ?? []).filter((hit) => hit > now - windowMs).length;
}

/** Borra el contador de una clave. Se usa al autenticarse con exito. */
export async function clearRateLimit(key: string): Promise<void> {
  const redis = getRedis();
  if (redis && redis.status === "ready") {
    await redis.del(key).catch(() => 0);
  }
  memoryBuckets.delete(key);
}
