import { checkDatabaseHealth } from "@scire/database";
import cors from "cors";
import express, { type Express } from "express";
import helmet from "helmet";
import { errorHandler } from "./lib/http.js";
import { bindTenant, bindTenantIfAuthenticated, requireAuth } from "./middleware/auth.js";
import { absencesRouter } from "./modules/absences/absences.routes.js";
import { auditRouter } from "./modules/audit/audit.routes.js";
import { authRouter } from "./modules/auth/auth.routes.js";
import { billingRouter } from "./modules/billing/billing.routes.js";
import { biometricRouter } from "./modules/biometric/biometric.routes.js";
import { companyRouter } from "./modules/company/company.routes.js";
import { platformRouter } from "./modules/platform/platform.routes.js";
import { punchRouter } from "./modules/punch/punch.routes.js";
import { reportsRouter } from "./modules/reports/reports.routes.js";
import { shiftsRouter } from "./modules/shifts/shifts.routes.js";
import { subscriptionRouter } from "./modules/subscription/subscription.routes.js";
import { usersRouter } from "./modules/users/users.routes.js";

/**
 * Ensamblado de la aplicacion Express.
 *
 * El orden de los middlewares es la arquitectura de seguridad:
 *   helmet/cors  -> cabeceras y origenes
 *   requireAuth  -> valida el token y comprueba que la sesion sigue viva
 *   bindTenant   -> abre el contexto de tenant con el companyId FIRMADO
 *   routers      -> a partir de aqui, `db` ya filtra por empresa sola
 *   errorHandler -> traduce AppError a HTTP y nunca filtra un stack trace
 */
export function createApp(): Express {
  const app = express();

  app.disable("x-powered-by");
  app.set("trust proxy", 1); // Easypanel / Traefik van delante: preserva la IP real.

  app.use(helmet());
  app.use(cors({ origin: process.env.APP_URL ?? true, credentials: true }));

  // Los webhooks de pago se montan ANTES del parser JSON global y con el
  // cuerpo en CRUDO: la firma criptografica se calcula sobre los bytes
  // exactos que envio la pasarela. Un `JSON.parse` + `JSON.stringify` de ida
  // y vuelta reordena claves y normaliza espacios, y la firma deja de validar.
  app.use("/api/v1/billing/webhook", express.raw({ type: "*/*", limit: "512kb" }), billingRouter);

  // Las selfies NO pasan por aqui: suben directas a S3/R2 con presigned URL.
  // Un limite bajo de body es suficiente y acota la superficie de abuso.
  app.use(express.json({ limit: "256kb" }));

  app.get("/health", async (_req, res) => {
    const database = await checkDatabaseHealth();
    res.status(database.ok ? 200 : 503).json({
      status: database.ok ? "ok" : "degraded",
      version: process.env.npm_package_version ?? "0.1.0",
      uptimeSeconds: Math.round(process.uptime()),
      checks: { database },
    });
  });

  // Publico: login, registro de empresa, refresco y aceptacion de invitacion.
  app.use("/api/v1/auth", authRouter);

  // Todo lo demas exige token valido y contexto de tenant abierto.
  app.use("/api/v1/punch", requireAuth, bindTenant, punchRouter);
  app.use("/api/v1/shifts", requireAuth, bindTenant, shiftsRouter);
  app.use("/api/v1/audit", requireAuth, bindTenant, auditRouter);
  app.use("/api/v1/absences", requireAuth, bindTenant, absencesRouter);
  app.use("/api/v1/company", requireAuth, bindTenant, companyRouter);
  app.use("/api/v1/users", requireAuth, bindTenant, usersRouter);
  app.use("/api/v1/reports", requireAuth, bindTenant, reportsRouter);
  app.use("/api/v1/subscription", requireAuth, bindTenant, subscriptionRouter);
  // El resto del router de facturacion (planes, checkout, cancelacion) si
  // necesita el cuerpo parseado y autenticacion propia por ruta.
  app.use("/api/v1/billing", bindTenantIfAuthenticated, billingRouter);
  // Relojes biometricos: cada ruta elige su credencial (token del reloj o
  // sesion de RRHH) y abre ella misma el contexto de tenant.
  app.use("/api/v1/biometric", biometricRouter);
  // Consola SUPER_ADMIN: cruza tenants, asi que va SIN `bindTenant`. El
  // router exige el rol y su servicio filtra por `companyId` explicito.
  app.use("/api/v1/platform", requireAuth, platformRouter);

  app.use((_req, res) => {
    res.status(404).json({
      success: false,
      error: { code: "NOT_FOUND", message: "Ruta no encontrada" },
    });
  });

  app.use(errorHandler);

  return app;
}
