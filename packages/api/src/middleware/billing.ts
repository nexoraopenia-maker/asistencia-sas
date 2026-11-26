import { getSystemClient } from "@scire/database";
import {
  AccountStatus,
  AppError,
  ErrorCode,
  Feature,
  PLAN_LIMITS,
  UserStatus,
  canOperate,
  hasFeature,
  minimumTierFor,
  type SubscriptionTier,
} from "@scire/shared";
import type { RequestHandler } from "express";

/**
 * Guards de plan y cuota.
 *
 * Los tres comparten una idea: **el limite se comprueba en el servidor, en el
 * punto donde se consume**. Ocultar un boton en la interfaz orienta al
 * usuario; no impide nada a quien llame a la API directamente.
 */

const system = getSystemClient();

interface CompanyPlan {
  tier: SubscriptionTier;
  accountStatus: AccountStatus;
  maxEmployees: number;
}

/**
 * Lee el plan de la empresa con el cliente de sistema.
 *
 * No usa `db` (el cliente con aislamiento) a proposito: estos guards corren
 * antes que algunos `bindTenant` y consultan `Company`, que no esta bajo la
 * extension de tenant. El filtro por id es explicito.
 */
async function loadPlan(companyId: string): Promise<CompanyPlan> {
  const company = await system.company.findUnique({
    where: { id: companyId },
    select: { tier: true, accountStatus: true, maxEmployees: true },
  });
  if (!company) throw new AppError(ErrorCode.NOT_FOUND, "Empresa no encontrada");
  return company as CompanyPlan;
}

/**
 * Exige que la cuenta pueda operar.
 *
 * `PAST_DUE` pasa: durante los dias de gracia la empresa sigue trabajando.
 * Cortar el fichaje el mismo dia que caduca una tarjeta castiga a empleados
 * que no pueden hacer nada al respecto y deja a la empresa sin registro de
 * asistencia con valor legal.
 */
export const requireActiveAccount: RequestHandler = (req, _res, next) => {
  void (async () => {
    try {
      if (!req.auth) throw new AppError(ErrorCode.UNAUTHENTICATED, "Autenticacion requerida");
      const plan = await loadPlan(req.auth.companyId);

      if (!canOperate(plan.accountStatus)) {
        throw new AppError(
          ErrorCode.SUBSCRIPTION_INACTIVE,
          "La cuenta de tu empresa esta suspendida. Regulariza el pago para reactivar el servicio.",
          { accountStatus: plan.accountStatus },
        );
      }
      next();
    } catch (error) {
      next(error);
    }
  })();
};

/**
 * Restringe una ruta a los planes que incluyen la funcionalidad.
 *
 * El error lleva `requiredTier` para que el panel pueda ofrecer el upgrade
 * concreto en vez de un "no disponible" sin salida.
 */
export function checkFeature(feature: Feature): RequestHandler {
  return (req, _res, next) => {
    void (async () => {
      try {
        if (!req.auth) throw new AppError(ErrorCode.UNAUTHENTICATED, "Autenticacion requerida");
        const plan = await loadPlan(req.auth.companyId);

        if (!canOperate(plan.accountStatus)) {
          throw new AppError(
            ErrorCode.SUBSCRIPTION_INACTIVE,
            "La cuenta de tu empresa esta suspendida",
            { accountStatus: plan.accountStatus },
          );
        }

        if (!hasFeature(plan.tier, feature)) {
          const required = minimumTierFor(feature);
          throw new AppError(
            ErrorCode.FEATURE_NOT_IN_PLAN,
            required
              ? `Esta funcionalidad requiere el plan ${PLAN_LIMITS[required].displayName} o superior.`
              : "Esta funcionalidad no esta incluida en tu plan.",
            { feature, tier: plan.tier, requiredTier: required },
          );
        }
        next();
      } catch (error) {
        next(error);
      }
    })();
  };
}

/** Compatibilidad con el nombre usado en las fases anteriores. */
export const requireFeature = checkFeature;

export interface SeatUsage {
  used: number;
  limit: number;
  available: number;
  percent: number;
}

/**
 * Consumo de asientos.
 *
 * Cuentan los ACTIVE y los INVITED: una invitacion pendiente ya reserva la
 * plaza. Si no contara, una empresa podria invitar a 200 personas con un plan
 * de 10 y encontrarse el limite superado en cuanto activaran su cuenta.
 */
export async function getSeatUsage(companyId: string): Promise<SeatUsage> {
  const [plan, used] = await Promise.all([
    loadPlan(companyId),
    system.user.count({
      where: { companyId, status: { in: [UserStatus.ACTIVE, UserStatus.INVITED] } },
    }),
  ]);

  return {
    used,
    limit: plan.maxEmployees,
    available: Math.max(0, plan.maxEmployees - used),
    percent: Math.min(100, Math.round((used / plan.maxEmployees) * 100)),
  };
}

export async function assertSeatsAvailable(companyId: string, needed = 1): Promise<SeatUsage> {
  const usage = await getSeatUsage(companyId);
  if (usage.used + needed > usage.limit) {
    throw new AppError(
      ErrorCode.EMPLOYEE_LIMIT_REACHED,
      `Tu plan admite ${usage.limit} colaboradores y ya tienes ${usage.used}. Amplia el plan para seguir dando de alta.`,
      { limit: usage.limit, used: usage.used, requested: needed },
    );
  }
  return usage;
}

/**
 * Bloquea el alta si la empresa esta en su cupo.
 *
 * `seatsFrom` permite contar cuantas plazas pide el cuerpo de la peticion —una
 * invitacion masiva de 30 personas consume 30— en vez de asumir siempre una.
 */
export function checkSeatLimit(
  seatsFrom: (body: unknown) => number = () => 1,
): RequestHandler {
  return (req, _res, next) => {
    void (async () => {
      try {
        if (!req.auth) throw new AppError(ErrorCode.UNAUTHENTICATED, "Autenticacion requerida");
        await assertSeatsAvailable(req.auth.companyId, Math.max(1, seatsFrom(req.body)));
        next();
      } catch (error) {
        next(error);
      }
    })();
  };
}

export { Feature };
