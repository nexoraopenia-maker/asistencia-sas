import { enterTenantContext, getSystemClient } from "@scire/database";
import { AccountStatus, AppError, canOperate, ErrorCode, UserRole } from "@scire/shared";
import type { RequestHandler } from "express";
import { hashToken } from "../lib/jwt.js";
import { bindTenant, requireAuth, requireRole } from "./auth.js";

/**
 * Autenticacion de relojes biometricos.
 *
 * Un reloj se identifica con un token opaco en la cabecera `X-Device-Key`. El
 * token se emite desde el panel de RRHH, se guarda solo su SHA-256 y fija la
 * empresa: el cuerpo de la peticion no puede elegir a que tenant escribe, igual
 * que con el `companyId` firmado del JWT.
 */

export const DEVICE_KEY_HEADER = "x-device-key";

const system = getSystemClient();

export const requireDeviceAuth: RequestHandler = (req, _res, next) => {
  void (async () => {
    try {
      const token = req.header(DEVICE_KEY_HEADER)?.trim();
      if (!token) {
        throw new AppError(ErrorCode.UNAUTHENTICATED, "Falta la cabecera X-Device-Key");
      }

      const device = await system.biometricDevice.findUnique({
        where: { tokenHash: hashToken(token) },
        select: {
          id: true,
          companyId: true,
          branchId: true,
          name: true,
          isActive: true,
          revokedAt: true,
          company: { select: { accountStatus: true } },
        },
      });

      // Token desconocido y token revocado responden igual: no se confirma a
      // quien prueba claves si alguna existio.
      if (!device || !device.isActive || device.revokedAt) {
        throw new AppError(ErrorCode.UNAUTHENTICATED, "Token de dispositivo invalido o revocado");
      }
      if (!canOperate(device.company.accountStatus as AccountStatus)) {
        throw new AppError(
          ErrorCode.SUBSCRIPTION_INACTIVE,
          "La cuenta de la empresa esta suspendida: el reloj no puede enviar marcaciones",
        );
      }

      await system.biometricDevice.update({
        where: { id: device.id },
        data: { lastSeenAt: new Date() },
      });

      req.device = {
        id: device.id,
        companyId: device.companyId,
        branchId: device.branchId,
        name: device.name,
      };

      enterTenantContext(
        {
          companyId: device.companyId,
          ipAddress: req.ip,
          userAgent: req.header("user-agent") ?? undefined,
        },
        next,
      );
    } catch (error) {
      next(error);
    }
  })();
};

/**
 * Acepta un reloj (`X-Device-Key`) o a RRHH con su sesion normal.
 *
 * El segundo camino cubre la importacion manual del log exportado del reloj
 * (USB, software del fabricante) desde el panel, sin dar de alta un dispositivo.
 */
export const requireDeviceOrHrAdmin: RequestHandler = (req, res, next) => {
  if (req.header(DEVICE_KEY_HEADER)) return requireDeviceAuth(req, res, next);

  requireAuth(req, res, (authError?: unknown) => {
    if (authError) return next(authError);
    bindTenant(req, res, (tenantError?: unknown) => {
      if (tenantError) return next(tenantError);
      requireRole(UserRole.HR_ADMIN)(req, res, next);
    });
  });
};
