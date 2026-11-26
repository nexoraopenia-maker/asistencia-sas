import { SubscriptionTier } from "./enums.js";

/**
 * Capacidades activables por plan (feature gating).
 *
 * Se consultan siempre con `hasFeature()`, nunca comparando el tier a mano:
 * un cambio de tarifa se aplica en un solo sitio y no hay que buscar
 * comparaciones sueltas repartidas por el codigo.
 */
export const Feature = {
  /** Marcacion con selfie + validacion de geocerca. Incluido en todos los planes. */
  BASIC_ATTENDANCE: "BASIC_ATTENDANCE",
  /** Multiples sucursales con geocercas independientes. */
  MULTI_BRANCH: "MULTI_BRANCH",
  /** Endpoint batch para sincronizar la cola offline del movil. */
  OFFLINE_BATCH: "OFFLINE_BATCH",
  /** Exportacion de nomina en PDF/Excel con horas netas y tardanzas. */
  ADVANCED_REPORTS: "ADVANCED_REPORTS",
  /** Disparo de eventos hacia n8n / Evolution API. */
  WEBHOOKS: "WEBHOOKS",
  /**
   * Consulta del rastro de auditoria sobre marcaciones.
   *
   * El `AuditLog` se ESCRIBE siempre, en todos los planes: es un requisito
   * legal, no una funcionalidad de pago. Lo que se factura es la consola de
   * consulta, no la existencia del registro.
   */
  AUDIT_TRAIL: "AUDIT_TRAIL",
  /**
   * Auditoria completa: todas las entidades, los accesos, y sin el limite de
   * historial del plan.
   */
  AUDIT_TRAIL_FULL: "AUDIT_TRAIL_FULL",
  /** Comparacion facial de la selfie contra la foto de perfil (AWS Rekognition). */
  FACE_MATCH: "FACE_MATCH",
  /** Constructor de informes a medida. */
  CUSTOM_REPORTS: "CUSTOM_REPORTS",
  /** Acceso a la API publica con tokens de servicio. */
  API_ACCESS: "API_ACCESS",
} as const;
export type Feature = (typeof Feature)[keyof typeof Feature];

export interface PlanLimits {
  readonly tier: SubscriptionTier;
  readonly displayName: string;
  /** Resumen de una linea para la tabla comparativa. */
  readonly tagline: string;
  /** Tope de usuarios en estado ACTIVE o INVITED. */
  readonly maxEmployees: number;
  /** Tope de sucursales. */
  readonly maxBranches: number;
  /** Meses de historial de marcaciones consultable. */
  readonly historyMonths: number;
  /** Dias de retencion de las selfies antes de la depuracion automatica. */
  readonly biometricRetentionDays: number;
  readonly features: readonly Feature[];
  /** Precio en USD/mes facturado mensualmente. */
  readonly monthlyPriceUsd: number;
  /**
   * Precio en USD/mes facturado anualmente (dos meses de descuento).
   * El cobro real es `yearlyPriceUsd * 12`.
   */
  readonly yearlyPriceUsd: number;
}

/**
 * Cuota "ilimitada" del plan Enterprise.
 *
 * Es un numero real y no `Infinity` por dos razones: `Infinity` no sobrevive a
 * `JSON.stringify` (se serializa como `null`) ni a una columna `Int` de
 * PostgreSQL. Un tope absurdamente alto se comporta como ilimitado y sigue
 * siendo un dato valido de punta a punta.
 */
export const UNLIMITED_SEATS = 100_000;

export const PLAN_LIMITS: Record<SubscriptionTier, PlanLimits> = {
  FREE: {
    tier: SubscriptionTier.FREE,
    displayName: "Free",
    tagline: "Para probar la marcacion con geocerca sin coste",
    maxEmployees: 3,
    maxBranches: 1,
    historyMonths: 1,
    biometricRetentionDays: 30,
    features: [Feature.BASIC_ATTENDANCE],
    monthlyPriceUsd: 0,
    yearlyPriceUsd: 0,
  },
  STARTER: {
    tier: SubscriptionTier.STARTER,
    displayName: "Starter",
    tagline: "Equipos pequenos con una o dos sedes",
    maxEmployees: 10,
    maxBranches: 2,
    historyMonths: 6,
    biometricRetentionDays: 60,
    features: [Feature.BASIC_ATTENDANCE, Feature.MULTI_BRANCH],
    monthlyPriceUsd: 29,
    yearlyPriceUsd: 24,
  },
  BUSINESS: {
    tier: SubscriptionTier.BUSINESS,
    displayName: "Business",
    tagline: "Modo sin conexion, nomina exportable e integraciones",
    maxEmployees: 50,
    maxBranches: 10,
    historyMonths: 24,
    biometricRetentionDays: 90,
    features: [
      Feature.BASIC_ATTENDANCE,
      Feature.MULTI_BRANCH,
      Feature.OFFLINE_BATCH,
      Feature.ADVANCED_REPORTS,
      Feature.WEBHOOKS,
      Feature.AUDIT_TRAIL,
    ],
    monthlyPriceUsd: 99,
    yearlyPriceUsd: 82,
  },
  ENTERPRISE: {
    tier: SubscriptionTier.ENTERPRISE,
    displayName: "Enterprise",
    tagline: "Verificacion facial, auditoria completa y cuota negociada",
    // Se sobreescribe por contrato en Company.maxEmployees.
    maxEmployees: UNLIMITED_SEATS,
    maxBranches: 1_000,
    historyMonths: 120,
    biometricRetentionDays: 365,
    features: [
      Feature.BASIC_ATTENDANCE,
      Feature.MULTI_BRANCH,
      Feature.OFFLINE_BATCH,
      Feature.ADVANCED_REPORTS,
      Feature.WEBHOOKS,
      Feature.AUDIT_TRAIL,
      Feature.AUDIT_TRAIL_FULL,
      Feature.FACE_MATCH,
      Feature.CUSTOM_REPORTS,
      Feature.API_ACCESS,
    ],
    monthlyPriceUsd: 299,
    yearlyPriceUsd: 249,
  },
};

/** Orden ascendente de planes. Util para comparar upgrades y downgrades. */
export const TIER_ORDER: readonly SubscriptionTier[] = [
  SubscriptionTier.FREE,
  SubscriptionTier.STARTER,
  SubscriptionTier.BUSINESS,
  SubscriptionTier.ENTERPRISE,
];

export function hasFeature(tier: SubscriptionTier, feature: Feature): boolean {
  return PLAN_LIMITS[tier].features.includes(feature);
}

export function isUpgrade(from: SubscriptionTier, to: SubscriptionTier): boolean {
  return TIER_ORDER.indexOf(to) > TIER_ORDER.indexOf(from);
}

/** Plan minimo que incluye una funcionalidad. Alimenta el mensaje de upgrade. */
export function minimumTierFor(feature: Feature): SubscriptionTier | null {
  return TIER_ORDER.find((tier) => hasFeature(tier, feature)) ?? null;
}

/** Precio mensual efectivo segun la periodicidad elegida. */
export function priceFor(tier: SubscriptionTier, interval: "MONTHLY" | "YEARLY"): number {
  const plan = PLAN_LIMITS[tier];
  return interval === "YEARLY" ? plan.yearlyPriceUsd : plan.monthlyPriceUsd;
}

/** Importe que se cobra en cada ciclo, en centavos. */
export function chargeAmountCents(
  tier: SubscriptionTier,
  interval: "MONTHLY" | "YEARLY",
): number {
  const monthly = priceFor(tier, interval);
  return Math.round(monthly * (interval === "YEARLY" ? 12 : 1) * 100);
}

/** Dias del trial gratuito por defecto para una empresa nueva. */
export const DEFAULT_TRIAL_DAYS = 14;

/** Umbral para avisar de que el trial se acaba. */
export const TRIAL_WARNING_DAYS = 3;

/**
 * Dias de gracia tras un cobro fallido antes de suspender la cuenta.
 *
 * Durante la gracia la empresa sigue operando: suspender el fichaje el mismo
 * dia que caduca una tarjeta castiga a los empleados, que no tienen forma de
 * arreglarlo, y deja a la empresa sin registro de asistencia con valor legal.
 */
export const PAST_DUE_GRACE_DAYS = 7;
