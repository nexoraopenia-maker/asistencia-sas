import { db, Prisma, tenantData, withAuditReason } from "@scire/database";
import {
  AbsenceType,
  AppError,
  createAbsenceSchema,
  ErrorCode,
  listAbsencesQuerySchema,
  reviewAbsenceSchema,
  UserRole,
} from "@scire/shared";
import { Router } from "express";
import { z } from "zod";
import { asyncHandler, ok, parseBody, parseQuery } from "../../lib/http.js";
import { requireRole } from "../../middleware/auth.js";

/**
 * Ausencias y justificaciones gestionadas por RRHH: descansos medicos,
 * vacaciones, tardanzas justificadas y solicitudes de horas extra. Solo las
 * APROBADAS afectan al calculo de los reportes.
 */
export const absencesRouter: Router = Router();

const SELECT = {
  id: true,
  type: true,
  status: true,
  startDate: true,
  endDate: true,
  reason: true,
  requestedMinutes: true,
  approvedMinutes: true,
  reviewNotes: true,
  reviewedAt: true,
  user: { select: { id: true, fullName: true, employeeCode: true } },
} satisfies Prisma.AbsenceSelect;

const day = (value: string) => new Date(`${value}T00:00:00.000Z`);

function serialize<T extends { startDate: Date; endDate: Date }>(row: T) {
  return {
    ...row,
    startDate: row.startDate.toISOString().slice(0, 10),
    endDate: row.endDate.toISOString().slice(0, 10),
  };
}

absencesRouter.get(
  "/",
  requireRole(UserRole.SUPERVISOR),
  asyncHandler(async (req, res) => {
    const query = parseQuery(listAbsencesQuerySchema, req.query);
    const rows = await db.absence.findMany({
      where: {
        ...(query.userId ? { userId: query.userId } : {}),
        ...(query.branchId ? { user: { branchId: query.branchId } } : {}),
        ...(query.type ? { type: query.type } : {}),
        ...(query.status ? { status: query.status } : {}),
        // Solapamiento con el rango consultado.
        ...(query.from ? { endDate: { gte: day(query.from) } } : {}),
        ...(query.to ? { startDate: { lte: day(query.to) } } : {}),
      },
      select: SELECT,
      orderBy: [{ startDate: "desc" }, { createdAt: "desc" }],
      take: 200,
    });
    ok(res, rows.map(serialize));
  }),
);

const createSchema = z.intersection(
  createAbsenceSchema,
  // RRHH puede registrar la justificacion ya aprobada en un solo paso.
  z.object({ approve: z.boolean().default(false) }),
);

absencesRouter.post(
  "/",
  requireRole(UserRole.HR_ADMIN),
  asyncHandler(async (req, res) => {
    const input = parseBody(createSchema, req.body);
    if (!input.userId) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, "Indica el colaborador");
    }
    const user = await db.user.findUnique({ where: { id: input.userId }, select: { id: true } });
    if (!user) throw new AppError(ErrorCode.NOT_FOUND, "Empleado no encontrado en tu empresa");

    const row = await db.absence.create({
      data: tenantData<Prisma.AbsenceUncheckedCreateInput>({
        userId: user.id,
        type: input.type,
        startDate: day(input.startDate),
        endDate: day(input.endDate),
        reason: input.reason,
        requestedMinutes: input.requestedMinutes ?? null,
        ...(input.approve
          ? {
              status: "APPROVED",
              approvedMinutes: input.requestedMinutes ?? null,
              reviewedById: req.auth!.sub,
              reviewedAt: new Date(),
            }
          : {}),
      }),
      select: SELECT,
    });
    await db.auditLog.create({
      data: tenantData<Prisma.AuditLogUncheckedCreateInput & { companyId: string }>({
        entityType: "Absence",
        recordId: row.id,
        action: input.approve ? "APPROVE" : "CREATE",
        modifiedByUserId: req.auth!.sub,
        newValue: { userId: user.id, type: input.type, from: input.startDate, to: input.endDate },
        reason: input.reason,
      }),
    });
    ok(res, serialize(row), 201);
  }),
);

absencesRouter.post(
  "/:id/review",
  requireRole(UserRole.HR_ADMIN),
  asyncHandler(async (req, res) => {
    const input = parseBody(reviewAbsenceSchema, { ...req.body, id: req.params.id });
    const current = await db.absence.findUnique({
      where: { id: input.id },
      select: { status: true, type: true, requestedMinutes: true, userId: true },
    });
    if (!current) throw new AppError(ErrorCode.NOT_FOUND, "Solicitud no encontrada");
    if (current.status !== "PENDING") {
      throw new AppError(ErrorCode.CONFLICT, "La solicitud ya fue resuelta");
    }
    if (current.userId === req.auth!.sub) {
      throw new AppError(ErrorCode.FORBIDDEN, "No puedes resolver tu propia solicitud");
    }

    const approvesOvertime =
      input.status === "APPROVED" && current.type === AbsenceType.OVERTIME_REQUEST;
    const row = await withAuditReason({ reason: input.reviewNotes }, () =>
      db.absence.update({
        where: { id: input.id },
        data: {
          status: input.status,
          reviewNotes: input.reviewNotes ?? null,
          reviewedById: req.auth!.sub,
          reviewedAt: new Date(),
          ...(approvesOvertime
            ? { approvedMinutes: input.approvedMinutes ?? current.requestedMinutes }
            : {}),
        },
        select: SELECT,
      }),
    );
    ok(res, serialize(row));
  }),
);
