/**
 * Enums de dominio.
 *
 * Estos valores son el espejo exacto de los `enum` de `schema.prisma`.
 * Se declaran aqui como objetos `as const` (y no se importan de `@prisma/client`)
 * para que `@scire/shared` sea consumible desde la app movil, donde el cliente
 * Prisma no existe.
 *
 * Al modificar un enum, actualiza SIEMPRE ambos lados.
 */

export const SubscriptionTier = {
  FREE: "FREE",
  STARTER: "STARTER",
  BUSINESS: "BUSINESS",
  ENTERPRISE: "ENTERPRISE",
} as const;
export type SubscriptionTier = (typeof SubscriptionTier)[keyof typeof SubscriptionTier];

export const SubscriptionStatus = {
  /** Periodo de prueba gratuito activo. */
  TRIALING: "TRIALING",
  ACTIVE: "ACTIVE",
  /** Cobro fallido; aun con acceso durante el periodo de gracia. */
  PAST_DUE: "PAST_DUE",
  /** Acceso bloqueado por impago o fin de trial. */
  SUSPENDED: "SUSPENDED",
  CANCELLED: "CANCELLED",
} as const;
export type SubscriptionStatus = (typeof SubscriptionStatus)[keyof typeof SubscriptionStatus];

export const UserRole = {
  /** Marca su propia asistencia y consulta sus turnos. */
  EMPLOYEE: "EMPLOYEE",
  /** Ve y aprueba al equipo de su(s) sucursal(es). */
  SUPERVISOR: "SUPERVISOR",
  /** Administra toda la empresa: personal, turnos, nomina, auditoria. */
  HR_ADMIN: "HR_ADMIN",
  /** Operador de la plataforma Scire. Transversal a todos los tenants. */
  SUPER_ADMIN: "SUPER_ADMIN",
} as const;
export type UserRole = (typeof UserRole)[keyof typeof UserRole];

/** Jerarquia de roles. Un rol hereda los permisos de todos los inferiores. */
export const ROLE_HIERARCHY: Record<UserRole, number> = {
  EMPLOYEE: 0,
  SUPERVISOR: 1,
  HR_ADMIN: 2,
  SUPER_ADMIN: 3,
};

export function roleAtLeast(actual: UserRole, required: UserRole): boolean {
  return ROLE_HIERARCHY[actual] >= ROLE_HIERARCHY[required];
}

export const UserStatus = {
  /** Invitado, aun no completo su registro. */
  INVITED: "INVITED",
  ACTIVE: "ACTIVE",
  /** Suspendido temporalmente; no puede marcar ni entrar. */
  SUSPENDED: "SUSPENDED",
  /** Baja definitiva. Se conserva por trazabilidad legal. */
  TERMINATED: "TERMINATED",
} as const;
export type UserStatus = (typeof UserStatus)[keyof typeof UserStatus];

export const ShiftType = {
  WORK: "WORK",
  LUNCH: "LUNCH",
} as const;
export type ShiftType = (typeof ShiftType)[keyof typeof ShiftType];

export const PunchType = {
  IN: "IN",
  OUT: "OUT",
  LUNCH_START: "LUNCH_START",
  LUNCH_END: "LUNCH_END",
} as const;
export type PunchType = (typeof PunchType)[keyof typeof PunchType];

/** Transiciones validas de marcacion. La clave es el ultimo tipo registrado del dia. */
export const VALID_PUNCH_TRANSITIONS: Record<PunchType | "NONE", readonly PunchType[]> = {
  NONE: ["IN"],
  IN: ["LUNCH_START", "OUT"],
  LUNCH_START: ["LUNCH_END"],
  LUNCH_END: ["OUT"],
  OUT: [],
} as const;

export const VerificationStatus = {
  /** Recibida; pendiente de face-match o de revision. */
  PENDING: "PENDING",
  VERIFIED: "VERIFIED",
  /** Face-match por debajo del umbral. */
  REJECTED: "REJECTED",
  /** GPS falso, fuera de geocerca o desfase de reloj anomalo. */
  SUSPICIOUS: "SUSPICIOUS",
  /** Corregida a mano por RRHH. Deja rastro en AuditLog. */
  MANUAL_OVERRIDE: "MANUAL_OVERRIDE",
} as const;
export type VerificationStatus = (typeof VerificationStatus)[keyof typeof VerificationStatus];

/** Origen de la marcacion. Permite distinguir una marcacion offline de una online. */
export const PunchSource = {
  MOBILE: "MOBILE",
  /** Sincronizada desde la cola offline del dispositivo. */
  MOBILE_OFFLINE: "MOBILE_OFFLINE",
  WEB: "WEB",
  /** Creada por RRHH desde el dashboard. */
  MANUAL: "MANUAL",
  /** Recibida de un reloj biometrico o importada de su log. */
  BIOMETRIC: "BIOMETRIC",
} as const;
export type PunchSource = (typeof PunchSource)[keyof typeof PunchSource];

export const AbsenceType = {
  MEDICAL_LEAVE: "MEDICAL_LEAVE",
  JUSTIFIED_TARDINESS: "JUSTIFIED_TARDINESS",
  OVERTIME_REQUEST: "OVERTIME_REQUEST",
  VACATION: "VACATION",
  PERSONAL_LEAVE: "PERSONAL_LEAVE",
  UNJUSTIFIED_ABSENCE: "UNJUSTIFIED_ABSENCE",
} as const;
export type AbsenceType = (typeof AbsenceType)[keyof typeof AbsenceType];

export const AbsenceStatus = {
  PENDING: "PENDING",
  APPROVED: "APPROVED",
  REJECTED: "REJECTED",
  CANCELLED: "CANCELLED",
} as const;
export type AbsenceStatus = (typeof AbsenceStatus)[keyof typeof AbsenceStatus];

export const AuditAction = {
  CREATE: "CREATE",
  UPDATE: "UPDATE",
  DELETE: "DELETE",
  /** Anulacion de una marcacion sin borrarla fisicamente. */
  VOID: "VOID",
  APPROVE: "APPROVE",
  REJECT: "REJECT",
  LOGIN: "LOGIN",
  LOGOUT: "LOGOUT",
  EXPORT: "EXPORT",
  /** Cambio de rol o de permisos. */
  PERMISSION_CHANGE: "PERMISSION_CHANGE",
} as const;
export type AuditAction = (typeof AuditAction)[keyof typeof AuditAction];

export const PaymentProvider = {
  MERCADOPAGO: "MERCADOPAGO",
  STRIPE: "STRIPE",
} as const;
export type PaymentProvider = (typeof PaymentProvider)[keyof typeof PaymentProvider];

export const InvoiceStatus = {
  DRAFT: "DRAFT",
  PENDING: "PENDING",
  PAID: "PAID",
  FAILED: "FAILED",
  REFUNDED: "REFUNDED",
  VOID: "VOID",
} as const;
export type InvoiceStatus = (typeof InvoiceStatus)[keyof typeof InvoiceStatus];

export const BillingInterval = {
  MONTHLY: "MONTHLY",
  YEARLY: "YEARLY",
} as const;
export type BillingInterval = (typeof BillingInterval)[keyof typeof BillingInterval];

/**
 * Estado operativo de la cuenta.
 *
 * Es la UNICA fuente de verdad sobre si una empresa puede operar. Convive con
 * `Subscription.status`, que refleja lo que dice la pasarela de pago; este
 * refleja lo que la plataforma le permite hacer, que no siempre es lo mismo
 * (por ejemplo durante los dias de gracia tras un cobro fallido).
 */
export const AccountStatus = {
  /** Periodo de prueba: acceso completo al plan elegido. */
  TRIALING: "TRIALING",
  ACTIVE: "ACTIVE",
  /** Cobro fallido. Sigue operando durante los dias de gracia. */
  PAST_DUE: "PAST_DUE",
  /** Sin acceso: impago tras la gracia, trial vencido o baja. */
  SUSPENDED: "SUSPENDED",
} as const;
export type AccountStatus = (typeof AccountStatus)[keyof typeof AccountStatus];

/**
 * Estados en los que la empresa puede seguir usando la plataforma.
 *
 * `PAST_DUE` entra a proposito: ver mas arriba por que la gracia importa.
 */
export function canOperate(status: AccountStatus): boolean {
  return status !== AccountStatus.SUSPENDED;
}
