import { enterTenantContext, getSystemClient } from "@scire/database";
import { AppError, ErrorCode, roleAtLeast, UserRole, UserStatus } from "@scire/shared";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { verifyAccessToken } from "../lib/jwt.js";

/**
 * Autenticacion y control de acceso.
 *
 * El orden de las capas importa:
 *   requireAuth  ->  valida el token y comprueba que la sesion sigue viva
 *   bindTenant   ->  abre el contexto de tenant con el companyId FIRMADO
 *   requireRole  ->  aplica el RBAC
 */

function extractBearer(req: Request): string {
  const header = req.header("authorization");
  if (!header?.startsWith("Bearer ")) {
    throw new AppError(ErrorCode.UNAUTHENTICATED, "Falta la cabecera Authorization: Bearer");
  }
  return header.slice(7).trim();
}

/**
 * Valida el access token y comprueba contra la base que la sesion no ha sido
 * revocada y que el empleado sigue activo.
 *
 * Se consulta la base en cada request a proposito. Un access token vive 15
 * minutos y no se puede invalidar por firma; sin esta comprobacion, un
 * empleado dado de baja o un dispositivo robado podrian seguir marcando
 * asistencia durante ese cuarto de hora. En un sistema con valor legal
 * laboral, ese margen no es aceptable. El coste es una consulta por id
 * (indice primario) y en la FASE 7 se cachea en Redis.
 *
 * Usa `getSystemClient()` porque resuelve la identidad ANTES de que exista
 * contexto de tenant: es precisamente la operacion que lo establece. El filtro
 * por `companyId` del token se aplica de forma explicita.
 */
export const requireAuth: RequestHandler = (req, _res, next) => {
  void (async () => {
    try {
      const payload = verifyAccessToken(extractBearer(req));
      const system = getSystemClient();

      const session = await system.session.findUnique({
        where: { id: payload.sid },
        select: {
          revokedAt: true,
          expiresAt: true,
          user: { select: { id: true, companyId: true, role: true, status: true } },
        },
      });

      if (!session || session.revokedAt || session.expiresAt < new Date()) {
        throw new AppError(ErrorCode.TOKEN_REVOKED, "La sesion ha sido cerrada o ha expirado");
      }

      const user = session.user;
      // El token dice una cosa y la base otra: token manipulado o empleado
      // movido de empresa. En ambos casos no se sigue adelante.
      if (user.id !== payload.sub || user.companyId !== payload.companyId) {
        throw new AppError(ErrorCode.CROSS_TENANT_ACCESS, "El token no corresponde a esta cuenta");
      }

      if (user.status !== UserStatus.ACTIVE) {
        throw new AppError(
          ErrorCode.USER_SUSPENDED,
          "Tu cuenta no esta activa. Contacta con Recursos Humanos.",
        );
      }

      // El rol vigente manda sobre el que lleve el token: un cambio de
      // permisos surte efecto de inmediato, sin esperar a que expire.
      req.auth = { ...payload, role: user.role as UserRole };
      next();
    } catch (error) {
      next(error);
    }
  })();
};

/**
 * Abre el contexto de tenant SOLO si la peticion viene autenticada.
 *
 * Lo necesitan los routers mixtos, donde conviven rutas publicas (el catalogo
 * de planes) con rutas de tenant (el checkout): montar `bindTenant` a secas
 * dejaria las publicas sin contexto y las privadas sin filtro.
 */
export const bindTenantIfAuthenticated: RequestHandler = (req, res, next) => {
  if (!req.auth) return next();
  return bindTenant(req, res, next);
};

/**
 * Abre el contexto de tenant para todo lo que ocurra despues.
 *
 * A partir de aqui, cualquier consulta con `db` queda filtrada por la empresa
 * del token sin escribir un solo `where: { companyId }`.
 */
export const bindTenant: RequestHandler = (req, _res, next) => {
  if (!req.auth) return next();
  enterTenantContext(
    {
      companyId: req.auth.companyId,
      userId: req.auth.sub,
      role: req.auth.role,
      sessionId: req.auth.sid,
      ipAddress: req.ip,
      userAgent: req.header("user-agent") ?? undefined,
    },
    next,
  );
};

/**
 * RBAC jerarquico: `requireRole(UserRole.HR_ADMIN)` deja pasar tambien a
 * SUPER_ADMIN, pero no a SUPERVISOR ni a EMPLOYEE.
 */
export function requireRole(minimum: UserRole): RequestHandler {
  return (req, _res, next) => {
    if (!req.auth) {
      return next(new AppError(ErrorCode.UNAUTHENTICATED, "Autenticacion requerida"));
    }
    if (!roleAtLeast(req.auth.role, minimum)) {
      return next(
        new AppError(ErrorCode.FORBIDDEN, "No tienes permisos suficientes para esta operacion"),
      );
    }
    next();
  };
}

/**
 * El feature gating y la cuota de asientos viven en `middleware/billing.ts`.
 * Se reexportan aqui porque las rutas de las fases anteriores los importan
 * desde este modulo.
 */
export { checkFeature, requireFeature, checkSeatLimit, requireActiveAccount } from "./billing.js";
export { Feature } from "@scire/shared";
