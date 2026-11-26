import { AsyncLocalStorage } from "node:async_hooks";
import { TenantIsolationError, type UserRole } from "@scire/shared";

/**
 * Contexto de tenant del request en curso.
 *
 * `companyId` procede SIEMPRE del claim firmado del JWT, nunca del body,
 * la query ni una cabecera. Ver docs/multitenancy.md, capa 1.
 */
export interface TenantContext {
  readonly companyId: string;
  readonly userId?: string;
  readonly role?: UserRole;
  /** Id de sesion, para poder atribuir la accion en AuditLog. */
  readonly sessionId?: string;
  readonly ipAddress?: string;
  readonly userAgent?: string;
}

const tenantStorage = new AsyncLocalStorage<TenantContext>();

/**
 * Ejecuta `fn` con un contexto de tenant activo y espera su resultado DENTRO
 * del contexto.
 *
 * El `await` interno no es un detalle cosmetico: las `PrismaPromise` son
 * perezosas — `db.user.findMany()` no lanza la consulta, solo construye un
 * thenable que se ejecuta al esperarlo. Si el `await` ocurriera fuera de este
 * scope, la extension correria ya sin contexto y lanzaria
 * `TenantIsolationError`. Esperar aqui garantiza que la consulta se dispara
 * con el tenant activo.
 *
 * AsyncLocalStorage propaga el contexto por toda la cadena de `await` sin
 * estado global: dos requests concurrentes de empresas distintas nunca ven el
 * contexto del otro.
 *
 * ```ts
 * const users = await runWithTenant({ companyId }, () => db.user.findMany());
 * ```
 */
export function runWithTenant<T>(
  context: TenantContext,
  fn: () => T | Promise<T>,
): Promise<T> {
  return tenantStorage.run(context, async () => await fn());
}

/**
 * Variante sincrona: cede el control a `fn` dentro del contexto sin envolverlo
 * en una promesa.
 *
 * Es la forma correcta de usarlo en un middleware de Express, donde `next()`
 * debe llamarse de forma sincrona y una excepcion tiene que propagarse tal
 * cual en lugar de convertirse en una promesa rechazada:
 *
 * ```ts
 * app.use((req, _res, next) => {
 *   if (!req.auth) return next();
 *   enterTenantContext({ companyId: req.auth.companyId }, next);
 * });
 * ```
 *
 * Todo el trabajo asincrono que arranque dentro de `fn` hereda el contexto.
 */
export function enterTenantContext<T>(context: TenantContext, fn: () => T): T {
  return tenantStorage.run(context, fn);
}

export function getTenantContext(): TenantContext | undefined {
  return tenantStorage.getStore();
}

export function requireTenantContext(): TenantContext {
  const ctx = tenantStorage.getStore();
  if (!ctx) throw new TenantIsolationError("<unknown>", "requireTenantContext");
  return ctx;
}

/**
 * Datos de creacion SIN `companyId`: lo pone la extension a partir del
 * contexto de tenant.
 *
 * Prisma exige `companyId` en sus tipos generados porque la columna es NOT
 * NULL, pero en tiempo de ejecucion nunca se escribe a mano. Este helper hace
 * explicito ese contrato en el punto de uso, en vez de esparcir `as` sueltos
 * que ocultarian un error real de tipos si el modelo cambiara.
 *
 * ```ts
 * await db.shift.create({ data: tenantData<Prisma.ShiftUncheckedCreateInput>({ userId, ... }) });
 * ```
 */
export function tenantData<T extends { companyId: string }>(data: Omit<T, "companyId">): T {
  return data as T;
}

/**
 * Modelos con aislamiento obligatorio por `companyId`.
 *
 * ⚠️ Anadir un modelo transaccional al schema sin anadirlo aqui es un bug de
 * seguridad: sus consultas saldrian sin filtro de tenant.
 *
 * Exclusiones deliberadas:
 * - `Company`      → se filtra por `id`, no por `companyId`.
 * - `BillingWebhookEvent` → tabla de plataforma; su `companyId` es nullable y
 *   se resuelve DESPUES de recibir el evento del proveedor de pago.
 */
export const TENANT_SCOPED_MODELS = new Set<string>([
  "Branch",
  "User",
  "Session",
  "Shift",
  "AttendanceRecord",
  "Absence",
  "AuditLog",
  "Subscription",
  "Invoice",
  "WebhookEndpoint",
  "WebhookDelivery",
  "BiometricDevice",
]);

/** Operaciones cuyo `where` debe llevar el filtro de tenant. */
const WHERE_OPERATIONS = new Set([
  "findUnique",
  "findUniqueOrThrow",
  "findFirst",
  "findFirstOrThrow",
  "findMany",
  "count",
  "aggregate",
  "groupBy",
  "update",
  "updateMany",
  "delete",
  "deleteMany",
]);

/** Operaciones que insertan filas y deben recibir el `companyId` en `data`. */
const CREATE_OPERATIONS = new Set(["create", "createMany", "createManyAndReturn"]);

type QueryArgs = Record<string, unknown>;

function injectWhere(args: QueryArgs, companyId: string): void {
  const where = (args.where ?? {}) as Record<string, unknown>;
  args.where = { ...where, companyId };
}

function injectData(args: QueryArgs, companyId: string): void {
  const data = args.data;
  if (Array.isArray(data)) {
    args.data = data.map((row) => ({ ...(row as object), companyId }));
  } else if (data && typeof data === "object") {
    args.data = { ...(data as object), companyId };
  } else {
    args.data = { companyId };
  }
}

/**
 * Extension de cliente Prisma que aplica el aislamiento multi-tenant.
 *
 * Intercepta TODAS las operaciones y reescribe los argumentos antes de que la
 * consulta llegue a PostgreSQL:
 *
 * | Operacion                          | Transformacion                       |
 * |------------------------------------|--------------------------------------|
 * | find*, count, aggregate, groupBy   | `where.companyId = <tenant>`         |
 * | create / createMany                | `data.companyId = <tenant>`          |
 * | update* / delete*                  | `where.companyId = <tenant>`         |
 * | upsert                             | `where` + `create.companyId`         |
 *
 * `findUnique` admite el filtro extra desde Prisma 5 (extendedWhereUnique):
 * `where: { id, companyId }` sigue resolviendo por el indice unico y anade la
 * condicion de tenant, de modo que un id de otra empresa devuelve null en vez
 * de la fila ajena.
 *
 * **Fail-closed**: si el modelo esta en `TENANT_SCOPED_MODELS` y no hay
 * contexto activo, se lanza `TenantIsolationError`. Olvidarse del contexto
 * produce una excepcion ruidosa, jamas una fuga silenciosa.
 *
 * Limitacion conocida: las **escrituras anidadas** (`create: { user: { ... } }`)
 * no se reescriben en profundidad. Se cubre desde el esquema, donde `companyId`
 * es NOT NULL: una escritura anidada sin tenant falla en la base de datos.
 */
export function tenantExtension() {
  return {
    name: "scire-tenant-isolation",
    query: {
      $allModels: {
        async $allOperations({
          model,
          operation,
          args,
          query,
        }: {
          model: string;
          operation: string;
          args: unknown;
          query: (args: unknown) => Promise<unknown>;
        }) {
          if (!TENANT_SCOPED_MODELS.has(model)) {
            return query(args);
          }

          const ctx = tenantStorage.getStore();
          if (!ctx) {
            throw new TenantIsolationError(model, operation);
          }

          const nextArgs = { ...((args ?? {}) as QueryArgs) };
          const { companyId } = ctx;

          if (operation === "upsert") {
            injectWhere(nextArgs, companyId);
            const create = (nextArgs.create ?? {}) as Record<string, unknown>;
            nextArgs.create = { ...create, companyId };
            // El tenant de una fila jamas se reasigna en un update.
            if (nextArgs.update && typeof nextArgs.update === "object") {
              const { companyId: _discarded, ...rest } = nextArgs.update as Record<string, unknown>;
              nextArgs.update = rest;
            }
            return query(nextArgs);
          }

          if (CREATE_OPERATIONS.has(operation)) {
            injectData(nextArgs, companyId);
            return query(nextArgs);
          }

          if (WHERE_OPERATIONS.has(operation)) {
            injectWhere(nextArgs, companyId);
            // Impide mover una fila a otra empresa desde un update.
            if (
              (operation === "update" || operation === "updateMany") &&
              nextArgs.data &&
              typeof nextArgs.data === "object" &&
              !Array.isArray(nextArgs.data)
            ) {
              const { companyId: _discarded, ...rest } = nextArgs.data as Record<string, unknown>;
              nextArgs.data = rest;
            }
            return query(nextArgs);
          }

          // Operaciones no contempladas (p. ej. $queryRaw enrutado por modelo):
          // se bloquean en lugar de dejarlas pasar sin filtro.
          throw new TenantIsolationError(model, operation);
        },
      },
    },
  } as const;
}
