import { db } from "@scire/database";
import {
  biometricImportSchema,
  createBiometricDeviceSchema,
  idSchema,
  UserRole,
} from "@scire/shared";
import { Router } from "express";
import { loadConfig } from "../../config.js";
import { asyncHandler, ok, parseBody } from "../../lib/http.js";
import { bindTenant, requireAuth, requireRole } from "../../middleware/auth.js";
import { requireDeviceAuth, requireDeviceOrHrAdmin } from "../../middleware/device-auth.js";
import { byIp, rateLimit } from "../../middleware/rate-limit.js";
import * as biometricService from "./biometric.service.js";

/**
 * Integracion con relojes biometricos.
 *
 * El router se monta sin autenticacion global porque conviven dos credenciales:
 * el token del reloj (`X-Device-Key`) y la sesion de RRHH. Cada ruta declara la
 * suya; ninguna abre el contexto de tenant con un `companyId` del cuerpo.
 */
export const biometricRouter: Router = Router();

const biometricLimiter = () =>
  rateLimit({
    bucket: "biometric",
    limit: loadConfig().RATE_LIMIT_BIOMETRIC_PER_MINUTE,
    windowSeconds: 60,
    keyBy: (req) => req.device?.id ?? req.auth?.sub ?? byIp(req),
    message: "Demasiados lotes seguidos desde este dispositivo. Espera un minuto.",
  });

const hrAdmin = [requireAuth, bindTenant, requireRole(UserRole.HR_ADMIN)];

/**
 * Recepcion / importacion de marcaciones.
 *
 * Idempotente: reenviar el mismo lote devuelve `duplicate` en cada elemento y
 * no crea nada. El reloj puede reintentar sin miedo tras un timeout.
 */
biometricRouter.post(
  "/punches",
  requireDeviceOrHrAdmin,
  biometricLimiter(),
  asyncHandler(async (req, res) => {
    const input = parseBody(biometricImportSchema, req.body);
    ok(
      res,
      await biometricService.importBiometricPunches(input, {
        deviceId: req.device?.id,
        deviceName: req.device?.name,
        defaultBranchId: req.device?.branchId ?? null,
      }),
    );
  }),
);

/** Prueba de conexion para el instalador del conector. */
biometricRouter.get(
  "/ping",
  requireDeviceAuth,
  asyncHandler(async (req, res) => {
    const company = await db.company.findUniqueOrThrow({
      where: { id: req.device!.companyId },
      select: { name: true, timezone: true },
    });
    ok(res, {
      device: { id: req.device!.id, name: req.device!.name, branchId: req.device!.branchId },
      company: { name: company.name, timezone: company.timezone },
      serverTime: new Date().toISOString(),
    });
  }),
);

biometricRouter.get(
  "/devices",
  ...hrAdmin,
  asyncHandler(async (_req, res) => {
    ok(res, await biometricService.listDevices());
  }),
);

biometricRouter.post(
  "/devices",
  ...hrAdmin,
  asyncHandler(async (req, res) => {
    const input = parseBody(createBiometricDeviceSchema, req.body);
    ok(res, await biometricService.createDevice(input), 201);
  }),
);

biometricRouter.post(
  "/devices/:id/revoke",
  ...hrAdmin,
  asyncHandler(async (req, res) => {
    await biometricService.revokeDevice(parseBody(idSchema, req.params.id));
    ok(res, { revoked: true });
  }),
);
