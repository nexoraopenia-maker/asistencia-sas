import { db } from "@scire/database";
import {
  bulkAssignShiftsSchema,
  createShiftSchema,
  updateShiftSchema,
  UserRole,
  weeklyScheduleQuerySchema,
} from "@scire/shared";
import { Router } from "express";
import { asyncHandler, ok, parseBody, parseQuery } from "../../lib/http.js";
import { requireRole } from "../../middleware/auth.js";
import * as shiftsService from "./shifts.service.js";

export const shiftsRouter: Router = Router();

/**
 * Calendario semanal con desglose de Trabajo y Refrigerio.
 *
 * Un EMPLOYEE solo puede consultar el suyo; el `userId` de la query se ignora
 * y se fuerza al del token.
 */
shiftsRouter.get(
  "/week",
  asyncHandler(async (req, res) => {
    const query = parseQuery(weeklyScheduleQuerySchema, req.query);
    const isPrivileged = req.auth!.role !== UserRole.EMPLOYEE;
    const userId = isPrivileged ? (query.userId ?? req.auth!.sub) : req.auth!.sub;

    const company = await db.company.findUniqueOrThrow({
      where: { id: req.auth!.companyId },
      select: { timezone: true },
    });

    ok(res, await shiftsService.getWeeklySchedule(userId, query.weekOf, company.timezone));
  }),
);

shiftsRouter.post(
  "/",
  requireRole(UserRole.SUPERVISOR),
  asyncHandler(async (req, res) => {
    const input = parseBody(createShiftSchema, req.body);
    ok(res, await shiftsService.createShift(input, req.auth!.sub), 201);
  }),
);

shiftsRouter.patch(
  "/:shiftId",
  requireRole(UserRole.SUPERVISOR),
  asyncHandler(async (req, res) => {
    const input = parseBody(updateShiftSchema, { ...req.body, id: req.params.shiftId });
    ok(res, await shiftsService.updateShift(input));
  }),
);

shiftsRouter.delete(
  "/:shiftId",
  requireRole(UserRole.SUPERVISOR),
  asyncHandler(async (req, res) => {
    await shiftsService.deleteShift(req.params.shiftId!);
    ok(res, { deleted: true });
  }),
);

/** Asignacion masiva de plantillas horarias. Solo RRHH. */
shiftsRouter.post(
  "/bulk-assign",
  requireRole(UserRole.HR_ADMIN),
  asyncHandler(async (req, res) => {
    const input = parseBody(bulkAssignShiftsSchema, req.body);
    ok(res, await shiftsService.bulkAssignShifts(input, req.auth!.sub), 201);
  }),
);
