import { PrismaClient } from "@prisma/client";
import { auditExtension } from "./audit.js";
import { tenantExtension } from "./tenant.js";

/**
 * Clientes Prisma de la plataforma.
 *
 * Existen dos y la diferencia importa:
 *
 * - `db`               → cliente CON aislamiento de tenant. El que se usa en
 *                        el 99 % del codigo. Requiere un `runWithTenant()` activo.
 * - `getSystemClient()` → cliente SIN aislamiento. Solo para procesos de
 *                        plataforma que legitimamente cruzan tenants.
 */

const isProduction = process.env.NODE_ENV === "production";

function createBaseClient(): PrismaClient {
  return new PrismaClient({
    log: isProduction
      ? [{ emit: "event", level: "error" }]
      : [
          { emit: "event", level: "error" },
          { emit: "event", level: "warn" },
        ],
    errorFormat: isProduction ? "minimal" : "pretty",
  });
}

// En desarrollo, el hot-reload de Next.js y tsx re-evalua este modulo en cada
// cambio. Sin este cache global se abriria un pool de conexiones nuevo cada vez
// hasta agotar `max_connections` de PostgreSQL.
const globalForPrisma = globalThis as unknown as {
  __scireBaseClient?: PrismaClient;
};

const baseClient = globalForPrisma.__scireBaseClient ?? createBaseClient();
if (!isProduction) globalForPrisma.__scireBaseClient = baseClient;

/**
 * Cliente con aislamiento multi-tenant.
 *
 * Toda consulta a un modelo con `companyId` se filtra automaticamente por el
 * tenant del contexto activo. Sin contexto, lanza `TenantIsolationError`.
 *
 * Lleva ademas la extension de auditoria: todo UPDATE o DELETE sobre un modelo
 * de `AUDITED_MODELS` deja su entrada en `AuditLog` automaticamente.
 *
 * ```ts
 * const users = await runWithTenant({ companyId: req.auth.companyId }, () =>
 *   // Solo devuelve los empleados de esa empresa, sin escribir el filtro.
 *   db.user.findMany(),
 * );
 * ```
 */
export const db = baseClient.$extends(tenantExtension()).$extends(auditExtension(baseClient));

export type TenantPrismaClient = typeof db;

/**
 * Cliente SIN aislamiento de tenant. Ve todas las empresas.
 *
 * ⚠️ Usar EXCLUSIVAMENTE en procesos de plataforma:
 * - Onboarding: crea la Company, asi que aun no hay tenant.
 * - Webhooks de facturacion: el tenant se resuelve desde el payload del proveedor.
 * - Cron de retencion de datos biometricos: itera todas las empresas.
 * - Migraciones y scripts de mantenimiento.
 *
 * NUNCA en un handler de request de tenant. Su uso debe revisarse en code
 * review como codigo de seguridad y es rastreable con:
 *   grep -rn "getSystemClient" packages apps
 */
export function getSystemClient(): PrismaClient {
  return baseClient;
}

/** Cierra el pool de conexiones. Para el apagado ordenado del servidor. */
export async function disconnectDatabase(): Promise<void> {
  await baseClient.$disconnect();
}

/** Sonda de conectividad para el endpoint /health. */
export async function checkDatabaseHealth(): Promise<{ ok: boolean; latencyMs: number }> {
  const startedAt = Date.now();
  try {
    await baseClient.$queryRaw`SELECT 1`;
    return { ok: true, latencyMs: Date.now() - startedAt };
  } catch {
    return { ok: false, latencyMs: Date.now() - startedAt };
  }
}
