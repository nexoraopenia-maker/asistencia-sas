import { db } from "@scire/database";
import {
  PLAN_LIMITS,
  TIER_ORDER,
  TRIAL_WARNING_DAYS,
  UserRole,
  type SubscriptionTier,
} from "@scire/shared";
import { Router } from "express";
import { asyncHandler, ok } from "../../lib/http.js";
import { requireRole } from "../../middleware/auth.js";
import { getSeatUsage } from "../../middleware/billing.js";
import { getSubscriptionSummary } from "../billing/billing.service.js";

/**
 * Estado de la suscripcion para el panel.
 *
 * Reune el plan, el consumo y las facturas en una sola respuesta: la pagina de
 * suscripcion las necesita todas a la vez y tres peticiones encadenadas
 * producirian tres saltos de layout mientras cargan.
 */
export const subscriptionRouter: Router = Router();

subscriptionRouter.get(
  "/",
  requireRole(UserRole.HR_ADMIN),
  asyncHandler(async (req, res) => {
    const companyId = req.auth!.companyId;

    const [company, summary, seats, invoices] = await Promise.all([
      db.company.findUniqueOrThrow({
        where: { id: companyId },
        select: { tier: true, accountStatus: true, suspendedAt: true, graceEndsAt: true },
      }),
      getSubscriptionSummary(companyId),
      getSeatUsage(companyId),
      db.invoice.findMany({
        select: {
          id: true,
          status: true,
          amountCents: true,
          currency: true,
          issuedAt: true,
          paidAt: true,
          failedAt: true,
          failureReason: true,
          periodStart: true,
          periodEnd: true,
          hostedInvoiceUrl: true,
        },
        orderBy: { issuedAt: "desc" },
        take: 12,
      }),
    ]);

    const plan = PLAN_LIMITS[company.tier as SubscriptionTier];
    const branchesUsed = await db.branch.count({ where: { isActive: true } });

    ok(res, {
      plan: {
        tier: plan.tier,
        displayName: plan.displayName,
        tagline: plan.tagline,
        monthlyPriceUsd: plan.monthlyPriceUsd,
        yearlyPriceUsd: plan.yearlyPriceUsd,
        features: plan.features,
        historyMonths: plan.historyMonths,
        biometricRetentionDays: plan.biometricRetentionDays,
      },
      usage: {
        seatsUsed: seats.used,
        seatsLimit: seats.limit,
        seatsPercent: seats.percent,
        seatsAvailable: seats.available,
        branchesUsed,
        branchesLimit: plan.maxBranches,
      },
      subscription: summary,
      account: {
        status: company.accountStatus,
        suspendedAt: company.suspendedAt,
        graceEndsAt: company.graceEndsAt,
        // El panel muestra el banner con esto: calcularlo aqui evita que
        // interfaz y API discrepen sobre cuando avisar.
        trialEndingSoon:
          summary.trialDaysLeft !== null &&
          summary.trialDaysLeft <= TRIAL_WARNING_DAYS &&
          company.accountStatus === "TRIALING",
      },
      /** Catalogo completo para la tabla comparativa y el modal de upgrade. */
      catalog: TIER_ORDER.map((tier) => PLAN_LIMITS[tier]),
      invoices,
    });
  }),
);
