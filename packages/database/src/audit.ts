import { AsyncLocalStorage } from "node:async_hooks";
import type { Prisma, PrismaClient } from "@prisma/client";
import { getTenantContext } from "./tenant.js";

/**
 * Auditoria automatica de mutaciones con valor legal laboral.
 *
 * Se implementa como extension de cliente Prisma y no como una llamada
 * explicita en cada servicio por una razon concreta: una entrada de auditoria
 * que hay que acordarse de escribir es una entrada de auditoria que algun dia
 * falta. Aqui, cualquier UPDATE o DELETE sobre un modelo auditado genera su
 * registro venga de donde venga.
 */

/** Modelos cuyos cambios quedan registrados en AuditLog. */
export const AUDITED_MODELS = new Set<string>([
  "AttendanceRecord",
  "Shift",
  "Absence",
  "User",
]);

/** Campos ruidosos que no aportan nada al rastro legal. */
const IGNORED_FIELDS = new Set(["updatedAt"]);

/** Tope de filas que se auditan en una operacion masiva. */
const BULK_AUDIT_LIMIT = 500;

interface AuditReasonContext {
  /** Justificacion introducida por quien hace el cambio. */
  readonly reason?: string;
  /** Desactiva la auditoria para operaciones de sistema (seeds, migraciones de datos). */
  readonly skip?: boolean;
}

const auditStorage = new AsyncLocalStorage<AuditReasonContext>();

/**
 * Adjunta una justificacion a todas las mutaciones auditadas que ocurran
 * dentro de `fn`. Los endpoints de ajuste y anulacion la exigen por schema,
 * asi que el motivo siempre acaba en el registro.
 *
 * ```ts
 * await withAuditReason({ reason: input.reason }, () =>
 *   db.attendanceRecord.update({ where: { id }, data }),
 * );
 * ```
 */
export function withAuditReason<T>(
  context: AuditReasonContext,
  fn: () => T | Promise<T>,
): Promise<T> {
  return auditStorage.run(context, async () => await fn());
}

/** Devuelve solo los campos que cambiaron, en su valor anterior y nuevo. */
function diff(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): { previousValue: Record<string, unknown>; newValue: Record<string, unknown> } | null {
  const previousValue: Record<string, unknown> = {};
  const newValue: Record<string, unknown> = {};
  let changed = false;

  for (const key of Object.keys(after)) {
    if (IGNORED_FIELDS.has(key)) continue;
    const a = before[key];
    const b = after[key];
    // Fechas y Decimals no son comparables con !== , se normalizan a string.
    const norm = (v: unknown) => (v instanceof Date ? v.toISOString() : v);
    if (norm(a) !== norm(b)) {
      previousValue[key] = norm(a) ?? null;
      newValue[key] = norm(b) ?? null;
      changed = true;
    }
  }

  return changed ? { previousValue, newValue } : null;
}

/**
 * Deduce la accion concreta a partir de lo que cambio.
 * Una anulacion de marcacion es un UPDATE tecnico pero un VOID en el rastro
 * legal, y es asi como RRHH y un inspector esperan verlo.
 */
function resolveAction(
  operation: string,
  newValue: Record<string, unknown>,
): "UPDATE" | "DELETE" | "VOID" | "APPROVE" | "REJECT" {
  if (operation === "delete" || operation === "deleteMany") return "DELETE";
  if (newValue.isVoided === true) return "VOID";
  if (newValue.status === "APPROVED") return "APPROVE";
  if (newValue.status === "REJECTED") return "REJECT";
  return "UPDATE";
}

/** `AttendanceRecord` -> `attendanceRecord` */
function delegateKey(model: string): string {
  return model.charAt(0).toLowerCase() + model.slice(1);
}

type Delegate = {
  findMany: (args: unknown) => Promise<Record<string, unknown>[]>;
};

/**
 * Extension que registra en `AuditLog` toda mutacion sobre `AUDITED_MODELS`.
 *
 * Escribe con el cliente base y un `companyId` explicito, no a traves del
 * cliente con aislamiento: asi el registro es independiente del orden en que
 * se compongan las extensiones y no puede reentrar en si mismo.
 *
 * ⚠️ **La entrada se escribe DESPUES de que la mutacion tenga exito, en una
 * operacion separada.** No comparte transaccion con el cambio auditado: si el
 * llamante envuelve la mutacion en un `$transaction` que luego revierte, queda
 * una entrada huerfana. Se acepta a cambio de que la auditoria sea automatica;
 * para cambios criticos que requieran atomicidad estricta, el servicio debe
 * escribir la entrada dentro de su propia transaccion y marcar `skip: true`.
 */
export function auditExtension(base: PrismaClient) {
  return {
    name: "scire-audit-log",
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
          const isAudited =
            AUDITED_MODELS.has(model) &&
            ["update", "updateMany", "delete", "deleteMany"].includes(operation);

          if (!isAudited) return query(args);

          const auditCtx = auditStorage.getStore();
          if (auditCtx?.skip) return query(args);

          const tenant = getTenantContext();
          // Sin tenant no hay a quien atribuir el cambio; la extension de
          // aislamiento ya habra bloqueado la consulta antes de llegar aqui.
          if (!tenant) return query(args);

          const delegate = (base as unknown as Record<string, Delegate | undefined>)[
            delegateKey(model)
          ];
          // Un modelo auditado sin delegate significa que AUDITED_MODELS y el
          // schema se han desincronizado: no se bloquea la mutacion, pero se
          // avisa fuerte porque deja un hueco en el rastro legal.
          if (!delegate) {
            console.error(`[audit] no existe el delegate Prisma para "${model}"`);
            return query(args);
          }

          const where = (args as { where?: unknown }).where ?? {};

          // Estado previo. Se lee con el companyId del contexto para que la
          // instantanea no pueda abarcar filas de otro tenant.
          const before = await delegate.findMany({
            where: { ...(where as object), companyId: tenant.companyId },
            take: BULK_AUDIT_LIMIT,
          });

          const result = await query(args);

          if (before.length === 0) return result;

          const isDelete = operation === "delete" || operation === "deleteMany";
          const ids = before.map((row) => row.id as string);

          // Tras un UPDATE hay que releer: `updateMany` no devuelve las filas.
          const after = isDelete
            ? []
            : await delegate.findMany({
                where: { id: { in: ids }, companyId: tenant.companyId },
              });
          const afterById = new Map(after.map((row) => [row.id as string, row]));

          const entries = before
            .map((previous) => {
              const id = previous.id as string;
              const current = afterById.get(id);

              const changes = isDelete
                ? { previousValue: normalize(previous), newValue: {} }
                : current
                  ? diff(previous, current)
                  : null;

              if (!changes) return null;

              return {
                companyId: tenant.companyId,
                entityType: model,
                recordId: id,
                action: resolveAction(operation, changes.newValue),
                modifiedByUserId: tenant.userId ?? null,
                previousValue: changes.previousValue,
                newValue: changes.newValue,
                reason: auditCtx?.reason ?? null,
                ipAddress: tenant.ipAddress ?? null,
                userAgent: tenant.userAgent ?? null,
              };
            })
            .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

          if (entries.length > 0) {
            // Un fallo al auditar no debe deshacer una marcacion ya aplicada,
            // pero tiene que ser ruidoso: es un problema de cumplimiento.
            await base.auditLog
              .createMany({ data: entries as Prisma.AuditLogCreateManyInput[] })
              .catch((error: unknown) => {
                console.error("[audit] no se pudo registrar la mutacion", {
                  model,
                  operation,
                  error,
                });
              });
          }

          return result;
        },
      },
    },
  } as const;
}

/** Serializa fechas para que el JSON del rastro sea estable y comparable. */
function normalize(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (IGNORED_FIELDS.has(key)) continue;
    out[key] = value instanceof Date ? value.toISOString() : value;
  }
  return out;
}
