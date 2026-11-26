import { db } from "@scire/database";
import {
  adjustPunchSchema,
  batchPunchSchema,
  createPunchSchema,
  dateStringSchema,
  Feature,
  idSchema,
  paginationSchema,
  presignedUrlRequestSchema,
  UserRole,
  voidPunchSchema,
} from "@scire/shared";
import { Router } from "express";
import { z } from "zod";
import { loadConfig } from "../../config.js";
import { asyncHandler, ok, parseBody, parseQuery } from "../../lib/http.js";
import { byUserOrIp, rateLimit } from "../../middleware/rate-limit.js";
import { requireFeature, requireRole } from "../../middleware/auth.js";
import * as punchService from "./punch.service.js";

export const punchRouter: Router = Router();

/**
 * Limite de marcaciones por usuario.
 *
 * Una jornada real son cuatro marcaciones. Diez por minuto deja margen de
 * sobra para reintentos y para la sincronizacion offline, y corta en seco el
 * envio repetido —accidental o deliberado— que inflaria la tabla o intentaria
 * un ataque de repeticion.
 */
const punchLimiter = () =>
  rateLimit({
    bucket: "punch",
    limit: loadConfig().RATE_LIMIT_PUNCH_PER_MINUTE,
    windowSeconds: 60,
    keyBy: byUserOrIp,
    message: "Has enviado demasiadas marcaciones seguidas. Espera unos segundos.",
  });

/** Paso 1: firma la subida de la selfie directamente a S3/R2. */
punchRouter.post(
  "/presigned-url",
  punchLimiter(),
  asyncHandler(async (req, res) => {
    const input = parseBody(presignedUrlRequestSchema, req.body);
    ok(res, await punchService.requestPresignedUrl(req.auth!.sub, req.auth!.companyId, input));
  }),
);

/** Paso 2: confirma la marcacion citando la clave de la selfie ya subida. */
punchRouter.post(
  "/",
  punchLimiter(),
  asyncHandler(async (req, res) => {
    const input = parseBody(createPunchSchema, req.body);
    ok(res, await punchService.createPunch(req.auth!.sub, input), 201);
  }),
);

/**
 * Sincronizacion de la cola offline.
 * Requiere plan BUSINESS o superior: el modo offline es funcionalidad de pago.
 */
punchRouter.post(
  "/batch",
  punchLimiter(),
  requireFeature(Feature.OFFLINE_BATCH),
  asyncHandler(async (req, res) => {
    const input = parseBody(batchPunchSchema, req.body);
    ok(res, await punchService.createPunchBatch(req.auth!.sub, input));
  }),
);

/** Marcaciones de hoy del propio empleado. Alimenta el modal "Detalle del Turno". */
punchRouter.get(
  "/today",
  asyncHandler(async (req, res) => {
    const company = await db.company.findUniqueOrThrow({
      where: { id: req.auth!.companyId },
      select: { timezone: true },
    });
    ok(res, await punchService.getTodayPunches(req.auth!.sub, company.timezone));
  }),
);

const listQuerySchema = paginationSchema.extend({
  userId: idSchema.optional(),
  branchId: idSchema.optional(),
  from: dateStringSchema.optional(),
  to: dateStringSchema.optional(),
  onlyAlerts: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => v === "true"),
});

/**
 * Feed de marcaciones para el dashboard.
 *
 * Un EMPLOYEE solo puede consultar las suyas: el `userId` de la query se
 * ignora y se fuerza al del token. Sin esto, cualquier empleado podria leer
 * la asistencia de sus companeros pasando otro id.
 */
punchRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const query = parseQuery(listQuerySchema, req.query);
    const isPrivileged = req.auth!.role !== UserRole.EMPLOYEE;

    ok(
      res,
      await punchService.listPunches({
        ...query,
        userId: isPrivileged ? query.userId : req.auth!.sub,
      }),
    );
  }),
);

/** URL firmada para ver la selfie. Solo supervisores y RRHH. */
punchRouter.get(
  "/:recordId/selfie",
  requireRole(UserRole.SUPERVISOR),
  asyncHandler(async (req, res) => {
    ok(res, await punchService.getSelfieUrl(req.params.recordId!));
  }),
);

/** Correccion manual. Genera automaticamente su entrada en AuditLog. */
punchRouter.patch(
  "/:recordId",
  requireRole(UserRole.HR_ADMIN),
  asyncHandler(async (req, res) => {
    const input = parseBody(adjustPunchSchema, { ...req.body, recordId: req.params.recordId });
    ok(res, await punchService.adjustPunch(input));
  }),
);

/** Anulacion (soft delete). Genera automaticamente su entrada en AuditLog. */
punchRouter.post(
  "/:recordId/void",
  requireRole(UserRole.HR_ADMIN),
  asyncHandler(async (req, res) => {
    const input = parseBody(voidPunchSchema, { ...req.body, recordId: req.params.recordId });
    ok(res, await punchService.voidPunch(input, req.auth!.sub));
  }),
);
