import { db } from "@scire/database";
import { Feature, idSchema, paginationSchema, UserRole } from "@scire/shared";
import { Router } from "express";
import { z } from "zod";
import { asyncHandler, ok, parseQuery } from "../../lib/http.js";
import { requireRole } from "../../middleware/auth.js";
import { checkFeature } from "../../middleware/billing.js";

/**
 * Consulta del rastro de auditoria.
 *
 * Solo lectura y solo para HR_ADMIN o superior: `AuditLog` es append-only y no
 * existe ningun endpoint que permita modificarla o borrarla. Esa ausencia es
 * la garantia; un "endpoint de limpieza" vaciaria de sentido la tabla.
 */
export const auditRouter: Router = Router();

/**
 * Acciones que NO son modificaciones de datos laborales.
 *
 * Los accesos generan una entrada por cada inicio de sesion y en pocas semanas
 * son el 95 % de la tabla. Dejarlos en la vista por defecto entierra
 * exactamente lo que este modulo existe para inspeccionar: quien edito o anulo
 * una marcacion. Siguen consultables con `scope=all`.
 */
const ACCESS_ACTIONS = ["LOGIN", "LOGOUT"] as const;

const querySchema = paginationSchema.extend({
  entityType: z.enum(["AttendanceRecord", "Shift", "Absence", "User", "Session"]).optional(),
  recordId: idSchema.optional(),
  modifiedByUserId: idSchema.optional(),
  action: z
    .enum(["CREATE", "UPDATE", "DELETE", "VOID", "APPROVE", "REJECT", "LOGIN", "LOGOUT", "EXPORT", "PERMISSION_CHANGE"])
    .optional(),
  /** `changes` (por defecto) oculta los accesos; `all` los incluye. */
  scope: z.enum(["changes", "all"]).default("changes"),
});

auditRouter.get(
  "/",
  requireRole(UserRole.HR_ADMIN),
  checkFeature(Feature.AUDIT_TRAIL),
  asyncHandler(async (req, res) => {
    const query = parseQuery(querySchema, req.query);

    const where = {
      ...(query.entityType ? { entityType: query.entityType } : {}),
      ...(query.recordId ? { recordId: query.recordId } : {}),
      ...(query.modifiedByUserId ? { modifiedByUserId: query.modifiedByUserId } : {}),
      // Un filtro explicito de accion manda sobre el scope: si alguien pide
      // ver los LOGIN, es porque los quiere ver.
      ...(query.action
        ? { action: query.action }
        : query.scope === "changes"
          ? { action: { notIn: [...ACCESS_ACTIONS] } }
          : {}),
    };

    const [items, total] = await Promise.all([
      db.auditLog.findMany({
        where,
        select: {
          id: true,
          entityType: true,
          recordId: true,
          action: true,
          previousValue: true,
          newValue: true,
          reason: true,
          ipAddress: true,
          timestamp: true,
          modifiedBy: { select: { id: true, fullName: true, employeeCode: true, role: true } },
        },
        orderBy: { timestamp: "desc" },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      db.auditLog.count({ where }),
    ]);

    ok(res, {
      items,
      page: query.page,
      pageSize: query.pageSize,
      total,
      totalPages: Math.ceil(total / query.pageSize),
    });
  }),
);

/** Historial completo de una marcacion concreta. */
auditRouter.get(
  "/record/:recordId",
  requireRole(UserRole.HR_ADMIN),
  checkFeature(Feature.AUDIT_TRAIL),
  asyncHandler(async (req, res) => {
    ok(
      res,
      await db.auditLog.findMany({
        where: { recordId: req.params.recordId! },
        select: {
          id: true,
          entityType: true,
          action: true,
          previousValue: true,
          newValue: true,
          reason: true,
          timestamp: true,
          modifiedBy: { select: { id: true, fullName: true, role: true } },
        },
        orderBy: { timestamp: "asc" },
      }),
    );
  }),
);
