import { dateRangeSchema, Feature, idSchema, UserRole } from "@scire/shared";
import { Router } from "express";
import { asyncHandler, ok, parseQuery } from "../../lib/http.js";
import { requireRole } from "../../middleware/auth.js";
import { checkFeature } from "../../middleware/billing.js";
import * as reportsService from "./reports.service.js";

export const reportsRouter: Router = Router();

const filtersSchema = dateRangeSchema.and(
  // `.and()` en vez de `.extend()`: dateRangeSchema lleva un `.refine()` que
  // valida from <= to, y extend lo perderia.
  dateRangeSchema.innerType().pick({}).extend({
    branchId: idSchema.optional(),
    userId: idSchema.optional(),
  }),
);

/** KPIs de puntualidad, ausentismo y horas extra para el panel de reportes. */
reportsRouter.get(
  "/summary",
  requireRole(UserRole.SUPERVISOR),
  asyncHandler(async (req, res) => {
    ok(res, await reportsService.getSummary(parseQuery(filtersSchema, req.query)));
  }),
);

/** Desglose por colaborador para la exportacion de nomina. */
reportsRouter.get(
  "/payroll",
  requireRole(UserRole.HR_ADMIN),
  // La exportacion de nomina es funcionalidad BUSINESS en adelante.
  checkFeature(Feature.ADVANCED_REPORTS),
  asyncHandler(async (req, res) => {
    ok(res, await reportsService.getPayroll(parseQuery(filtersSchema, req.query)));
  }),
);

/** Detalle por jornada: desglose de horas, tramo nocturno e incidencias. */
reportsRouter.get(
  "/detail",
  requireRole(UserRole.HR_ADMIN),
  checkFeature(Feature.ADVANCED_REPORTS),
  asyncHandler(async (req, res) => {
    ok(res, await reportsService.getDetail(parseQuery(filtersSchema, req.query)));
  }),
);
