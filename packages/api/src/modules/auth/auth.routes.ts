import {
  acceptInvitationSchema,
  biometricAuthSchema,
  changePasswordSchema,
  loginSchema,
  refreshTokenSchema,
  registerCompanySchema,
} from "@scire/shared";
import { Router, type Request } from "express";
import { loadConfig } from "../../config.js";
import { asyncHandler, ok, parseBody } from "../../lib/http.js";
import {
  byIp,
  byLoginIdentity,
  rateLimit,
  rateLimitAll,
} from "../../middleware/rate-limit.js";
import { requireAuth } from "../../middleware/auth.js";
import * as authService from "./auth.service.js";

/** Metadatos del dispositivo que se guardan con cada sesion. */
function sessionMeta(req: Request, extra: { deviceId?: string; deviceName?: string } = {}) {
  return {
    ipAddress: req.ip,
    userAgent: req.header("user-agent") ?? undefined,
    ...extra,
  };
}

export const authRouter: Router = Router();

/**
 * Proteccion contra fuerza bruta.
 *
 * Se aplican DOS limites a la vez y manda el mas restrictivo. Solo por IP, una
 * botnet prueba una contrasena por IP contra la misma cuenta sin tocar el
 * limite; solo por credencial, un atacante recorre miles de correos desde una
 * IP. Juntos cierran ambos caminos.
 */
const authLimiter = () =>
  rateLimitAll(
    rateLimit({
      bucket: "auth-ip",
      limit: loadConfig().RATE_LIMIT_AUTH_PER_MINUTE,
      windowSeconds: 60,
      keyBy: byIp,
      message: "Demasiados intentos desde esta conexion. Espera un minuto.",
    }),
    rateLimit({
      bucket: "auth-id",
      limit: loadConfig().RATE_LIMIT_AUTH_PER_MINUTE,
      windowSeconds: 60,
      keyBy: byLoginIdentity,
      message: "Demasiados intentos con esta cuenta. Espera un minuto.",
    }),
  );

/** Alta de una empresa nueva. Publico: es la puerta del onboarding. */
authRouter.post(
  "/register-company",
  authLimiter(),
  asyncHandler(async (req, res) => {
    const input = parseBody(registerCompanySchema, req.body);
    const result = await authService.registerCompany(input, sessionMeta(req));
    ok(res, result, 201);
  }),
);

authRouter.post(
  "/login",
  authLimiter(),
  asyncHandler(async (req, res) => {
    const input = parseBody(loginSchema, req.body);
    const result = await authService.login(
      input,
      sessionMeta(req, { deviceId: input.deviceId, deviceName: input.deviceName }),
    );
    ok(res, result);
  }),
);

authRouter.post(
  "/refresh",
  authLimiter(),
  asyncHandler(async (req, res) => {
    const input = parseBody(refreshTokenSchema, req.body);
    ok(res, await authService.refresh(input.refreshToken, sessionMeta(req)));
  }),
);

/**
 * Desbloqueo biometrico del movil. No recibe datos biometricos: el sistema
 * operativo ya valido al usuario y libero el refresh token del keychain.
 */
authRouter.post(
  "/biometric",
  authLimiter(),
  asyncHandler(async (req, res) => {
    const input = parseBody(biometricAuthSchema, req.body);
    ok(
      res,
      await authService.biometricAuth(
        input.refreshToken,
        sessionMeta(req, { deviceId: input.deviceId }),
      ),
    );
  }),
);

authRouter.post(
  "/accept-invitation",
  authLimiter(),
  asyncHandler(async (req, res) => {
    const input = parseBody(acceptInvitationSchema, req.body);
    ok(res, await authService.acceptInvitation(input, sessionMeta(req)), 201);
  }),
);

authRouter.post(
  "/logout",
  asyncHandler(async (req, res) => {
    const input = parseBody(refreshTokenSchema, req.body);
    await authService.logout(input.refreshToken);
    ok(res, { revoked: true });
  }),
);

// --- A partir de aqui hace falta un access token valido ---------------------

authRouter.get(
  "/me",
  requireAuth,
  asyncHandler(async (req, res) => {
    ok(res, await authService.getProfile(req.auth!.sub, req.auth!.companyId));
  }),
);

authRouter.post(
  "/change-password",
  requireAuth,
  asyncHandler(async (req, res) => {
    const input = parseBody(changePasswordSchema, req.body);
    await authService.changePassword(req.auth!.sub, req.auth!.companyId, input);
    ok(res, { changed: true, message: "Contrasena actualizada. Se cerraron las demas sesiones." });
  }),
);

authRouter.get(
  "/sessions",
  requireAuth,
  asyncHandler(async (req, res) => {
    ok(res, await authService.listSessions(req.auth!.sub, req.auth!.companyId));
  }),
);

authRouter.delete(
  "/sessions/:sessionId",
  requireAuth,
  asyncHandler(async (req, res) => {
    await authService.revokeSession(req.params.sessionId!, req.auth!.sub, req.auth!.companyId);
    ok(res, { revoked: true });
  }),
);
