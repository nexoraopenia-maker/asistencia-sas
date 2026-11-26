import { Redis } from "ioredis";
import { loadConfig } from "../config.js";

/**
 * Cliente Redis compartido.
 *
 * Redis es infraestructura de apoyo, no la fuente de verdad: se usa para rate
 * limiting y cache. Por eso la conexion NO reintenta indefinidamente ni
 * bloquea el arranque — si Redis no esta, la API sigue funcionando y los
 * limitadores caen a su respaldo en memoria.
 */

let client: Redis | null = null;
let unavailableSince: number | null = null;

/** Cada cuanto se reintenta la conexion tras marcarla como caida. */
const RETRY_AFTER_MS = 30_000;

export function getRedis(): Redis | null {
  const config = loadConfig();

  // Tras un fallo se deja de intentar durante un rato: reconectar en cada
  // peticion convertiria una caida de Redis en latencia en todas las rutas.
  if (unavailableSince && Date.now() - unavailableSince < RETRY_AFTER_MS) return null;

  if (client) return client;

  try {
    client = new Redis(config.REDIS_URL, {
      // Una sola reintentona: si Redis no responde, el limitador usa memoria.
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      connectTimeout: 1_000,
      lazyConnect: false,
      retryStrategy: (times: number) => (times > 3 ? null : Math.min(times * 200, 1_000)),
      ...(config.REDIS_PASSWORD ? { password: config.REDIS_PASSWORD } : {}),
    });

    client.on("error", (error: Error) => {
      // Un unico aviso por caida, no uno por peticion fallida.
      if (!unavailableSince) {
        console.warn("[redis] no disponible, los limitadores usan memoria:", error.message);
      }
      unavailableSince = Date.now();
    });

    client.on("ready", () => {
      if (unavailableSince) console.log("[redis] conexion restablecida");
      unavailableSince = null;
    });

    return client;
  } catch (error) {
    console.warn("[redis] no se pudo crear el cliente:", error);
    unavailableSince = Date.now();
    return null;
  }
}

export function isRedisReady(): boolean {
  return getRedis()?.status === "ready";
}

/**
 * Espera a que la conexion este lista, con tope.
 *
 * Sin esto, la PRIMERA peticion tras arrancar siempre cae al respaldo en
 * memoria: el cliente se construye en ese momento y su estado es "connecting",
 * no "ready". En un proceso recien desplegado eso deja el limitador
 * distribuido inactivo justo cuando llega la avalancha de reconexiones.
 *
 * El tope es de milisegundos: si Redis tarda mas, el respaldo en memoria es
 * preferible a hacer esperar a quien esta fichando.
 */
export async function awaitRedisReady(timeoutMs = 250): Promise<Redis | null> {
  const client = getRedis();
  if (!client) return null;
  if (client.status === "ready") return client;
  // Estados terminales: no va a conectar por esperar mas.
  if (client.status === "end" || client.status === "close") return null;

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      client.off("ready", onReady);
      resolve(null);
    }, timeoutMs);

    const onReady = () => {
      clearTimeout(timer);
      resolve(client);
    };

    client.once("ready", onReady);
  });
}

/**
 * Establece la conexion al arrancar el servidor.
 *
 * No falla si Redis no esta: solo deja constancia. La API tiene que poder
 * arrancar sin Redis, con los limitadores degradados a memoria.
 */
export async function initRedis(): Promise<boolean> {
  const client = await awaitRedisReady(2_000);
  if (client) {
    console.log("[redis] conectado, rate limiting distribuido activo");
    return true;
  }
  console.warn("[redis] no disponible, los limitadores usan memoria por proceso");
  return false;
}

export async function disconnectRedis(): Promise<void> {
  if (!client) return;
  await client.quit().catch(() => client?.disconnect());
  client = null;
}

/** Solo para tests: descarta el cliente memorizado y el estado de caida. */
export function resetRedis(): void {
  client?.disconnect();
  client = null;
  unavailableSince = null;
}
