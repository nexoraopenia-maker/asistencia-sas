import {
  createTenantSchema,
  idSchema,
  listTenantsQuerySchema,
  setTenantStatusSchema,
  UserRole,
} from "@scire/shared";
import { Router, type Request } from "express";
import { asyncHandler, ok, parseBody, parseQuery } from "../../lib/http.js";
import { requireRole } from "../../middleware/auth.js";
import * as platformService from "./platform.service.js";

/**
 * Rutas de la consola de plataforma.
 *
 * Se montan con `requireAuth` pero SIN `bindTenant`: el servicio trabaja con
 * el cliente de sistema y el tenant objetivo llega por la ruta. El RBAC se
 * aplica a nivel de router para que ninguna ruta nueva pueda quedar abierta
 * por olvidar el guard.
 */
export const platformRouter: Router = Router();

platformRouter.use(requireRole(UserRole.SUPER_ADMIN));

function actorFrom(req: Request): platformService.PlatformActor {
  return {
    userId: req.auth!.sub,
    companyId: req.auth!.companyId,
    ipAddress: req.ip,
    userAgent: req.header("user-agent") ?? undefined,
  };
}

platformRouter.get(
  "/tenants",
  asyncHandler(async (req, res) => {
    const query = parseQuery(listTenantsQuerySchema, req.query);
    ok(res, await platformService.listTenants(query));
  }),
);

platformRouter.post(
  "/tenants",
  asyncHandler(async (req, res) => {
    const input = parseBody(createTenantSchema, req.body);
    ok(res, await platformService.createTenant(input, actorFrom(req)), 201);
  }),
);

platformRouter.patch(
  "/tenants/:id/status",
  asyncHandler(async (req, res) => {
    const companyId = parseBody(idSchema, req.params.id);
    const input = parseBody(setTenantStatusSchema, req.body);
    ok(res, await platformService.setTenantStatus(companyId, input, actorFrom(req)));
  }),
);
