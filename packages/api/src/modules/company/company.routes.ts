import { db, Prisma, tenantData } from "@scire/database";
import {
  AppError,
  createBranchSchema,
  ErrorCode,
  Feature,
  hasFeature,
  PLAN_LIMITS,
  updateBranchSchema,
  updateCompanySchema,
  UserRole,
  type SubscriptionTier,
} from "@scire/shared";
import { Router } from "express";
import { asyncHandler, ok, parseBody } from "../../lib/http.js";
import { getRetentionStatus, purgeExpiredBiometrics } from "../../services/retention.service.js";
import { requireRole } from "../../middleware/auth.js";

/**
 * Empresa y sucursales.
 *
 * La configuracion de tolerancias vive aqui y no en variables de entorno: cada
 * empresa negocia sus propios minutos de gracia con su personal, y un cambio
 * de politica no puede exigir un redeploy.
 */
export const companyRouter: Router = Router();

const COMPANY_SELECT = {
  id: true,
  name: true,
  slug: true,
  taxId: true,
  timezone: true,
  logoUrl: true,
  lateToleranceMinutes: true,
  earlyLeaveToleranceMinutes: true,
  requireSelfie: true,
  requireGeofence: true,
  faceMatchEnabled: true,
  faceMatchMinScore: true,
  dataRetentionMonths: true,
  tier: true,
  maxEmployees: true,
  accountStatus: true,
  graceEndsAt: true,
} as const;

companyRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    ok(
      res,
      await db.company.findUniqueOrThrow({
        where: { id: req.auth!.companyId },
        select: COMPANY_SELECT,
      }),
    );
  }),
);

companyRouter.patch(
  "/",
  requireRole(UserRole.HR_ADMIN),
  asyncHandler(async (req, res) => {
    const input = parseBody(updateCompanySchema, req.body);

    // El face-match es funcionalidad ENTERPRISE: dejar activar el interruptor
    // en un plan inferior crearia la expectativa de una verificacion que nunca
    // llegaria a ejecutarse.
    if (input.faceMatchEnabled) {
      const company = await db.company.findUniqueOrThrow({
        where: { id: req.auth!.companyId },
        select: { tier: true },
      });
      if (!hasFeature(company.tier as SubscriptionTier, Feature.FACE_MATCH)) {
        throw new AppError(
          ErrorCode.FEATURE_NOT_IN_PLAN,
          "La verificacion facial requiere el plan Enterprise",
          { feature: Feature.FACE_MATCH, tier: company.tier },
        );
      }
    }

    ok(
      res,
      await db.company.update({
        where: { id: req.auth!.companyId },
        data: input,
        select: COMPANY_SELECT,
      }),
    );
  }),
);

/**
 * Estado de cumplimiento de la politica de retencion.
 *
 * Alimenta el panel: cuantas selfies hay guardadas, cuantas han superado el
 * plazo y cuantas se depuraron ya.
 */
companyRouter.get(
  "/retention",
  requireRole(UserRole.HR_ADMIN),
  asyncHandler(async (req, res) => {
    ok(res, await getRetentionStatus(req.auth!.companyId));
  }),
);

/**
 * Ejecuta la purga bajo demanda.
 *
 * El barrido automatico corre a diario; esto permite adelantarlo tras cambiar
 * el plazo. `dryRun` informa de cuanto se borraria sin borrarlo, que es lo
 * primero que se debe ejecutar al endurecer la politica.
 */
companyRouter.post(
  "/retention/purge",
  requireRole(UserRole.HR_ADMIN),
  asyncHandler(async (req, res) => {
    const dryRun = (req.body as { dryRun?: boolean } | undefined)?.dryRun === true;
    ok(res, await purgeExpiredBiometrics({ companyId: req.auth!.companyId, dryRun }));
  }),
);

// --- Sucursales -------------------------------------------------------------

const BRANCH_SELECT = {
  id: true,
  name: true,
  address: true,
  latitude: true,
  longitude: true,
  radiusMeters: true,
  timezone: true,
  isActive: true,
} as const;

companyRouter.get(
  "/branches",
  asyncHandler(async (_req, res) => {
    const branches = await db.branch.findMany({
      select: { ...BRANCH_SELECT, _count: { select: { users: true } } },
      orderBy: { name: "asc" },
    });
    ok(
      res,
      branches.map(({ _count, ...branch }) => ({ ...branch, employeeCount: _count.users })),
    );
  }),
);

companyRouter.post(
  "/branches",
  requireRole(UserRole.HR_ADMIN),
  asyncHandler(async (req, res) => {
    const input = parseBody(createBranchSchema, req.body);

    const company = await db.company.findUniqueOrThrow({
      where: { id: req.auth!.companyId },
      select: { tier: true },
    });
    const limit = PLAN_LIMITS[company.tier as SubscriptionTier].maxBranches;
    const current = await db.branch.count();
    if (current >= limit) {
      throw new AppError(
        ErrorCode.BRANCH_LIMIT_REACHED,
        `Tu plan permite hasta ${limit} sucursal${limit === 1 ? "" : "es"}`,
        { limit, current },
      );
    }

    try {
      ok(
        res,
        await db.branch.create({
          data: tenantData<Prisma.BranchUncheckedCreateInput>(input),
          select: BRANCH_SELECT,
        }),
        201,
      );
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new AppError(ErrorCode.CONFLICT, "Ya existe una sucursal con ese nombre");
      }
      throw error;
    }
  }),
);

companyRouter.patch(
  "/branches/:branchId",
  requireRole(UserRole.HR_ADMIN),
  asyncHandler(async (req, res) => {
    const input = parseBody(updateBranchSchema, { ...req.body, id: req.params.branchId });
    const { id, ...data } = input;

    const existing = await db.branch.findUnique({ where: { id }, select: { id: true } });
    if (!existing) throw new AppError(ErrorCode.NOT_FOUND, "Sucursal no encontrada");

    ok(res, await db.branch.update({ where: { id }, data, select: BRANCH_SELECT }));
  }),
);

/**
 * Desactivacion, nunca borrado.
 *
 * Una sucursal es la referencia de geocerca de marcaciones historicas con
 * valor legal: eliminarla dejaria esos registros sin el centro contra el que
 * se validaron. El FK es `onDelete: Restrict` justamente por eso.
 */
companyRouter.delete(
  "/branches/:branchId",
  requireRole(UserRole.HR_ADMIN),
  asyncHandler(async (req, res) => {
    const branchId = req.params.branchId!;
    const branch = await db.branch.findUnique({
      where: { id: branchId },
      select: { id: true, _count: { select: { users: true } } },
    });
    if (!branch) throw new AppError(ErrorCode.NOT_FOUND, "Sucursal no encontrada");
    if (branch._count.users > 0) {
      throw new AppError(
        ErrorCode.CONFLICT,
        `La sucursal tiene ${branch._count.users} empleado(s) asignados. Reasignalos antes de desactivarla.`,
      );
    }

    ok(
      res,
      await db.branch.update({
        where: { id: branchId },
        data: { isActive: false },
        select: BRANCH_SELECT,
      }),
    );
  }),
);
