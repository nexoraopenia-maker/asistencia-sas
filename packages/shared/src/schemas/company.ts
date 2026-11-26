import { z } from "zod";
import { UserRole, UserStatus } from "../enums.js";
import {
  emailSchema,
  idSchema,
  latitudeSchema,
  longitudeSchema,
  phoneSchema,
  timeStringSchema,
  timezoneSchema,
} from "./common.js";

export const updateCompanySchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  taxId: z.string().trim().max(32).nullable().optional(),
  timezone: timezoneSchema.optional(),
  logoUrl: z.string().url().max(512).nullable().optional(),
  /** Minutos de gracia antes de contar tardanza. */
  lateToleranceMinutes: z.number().int().min(0).max(120).optional(),
  /** Minutos de gracia para la salida anticipada. */
  earlyLeaveToleranceMinutes: z.number().int().min(0).max(120).optional(),
  /** Si false, se puede marcar sin foto (kiosco, entornos sin camara). */
  requireSelfie: z.boolean().optional(),
  /** Si false, se puede marcar fuera de la geocerca (trabajo en campo). */
  requireGeofence: z.boolean().optional(),
  faceMatchEnabled: z.boolean().optional(),
  faceMatchMinScore: z.number().min(0).max(100).optional(),
  /**
   * Meses de conservacion de las selfies de marcacion.
   *
   * El minimo de 1 mes evita una purga inmediata por error de dedo; el maximo
   * de 120 es un tope de sensatez — guardar datos biometricos una decada
   * "por si acaso" es justo lo que la limitacion del plazo de conservacion
   * pretende evitar.
   */
  dataRetentionMonths: z.number().int().min(1).max(120).optional(),

  // --- Jornada y calculo laboral -------------------------------------------
  maxShiftHours: z.number().int().min(6).max(36).optional(),
  allowSplitShifts: z.boolean().optional(),
  dailyOrdinaryMinutes: z.number().int().min(60).max(1_440).optional(),
  weeklyOrdinaryMinutes: z.number().int().min(60).max(10_080).optional(),
  overtimeThresholdMinutes: z.number().int().min(0).max(120).optional(),
  overtimeTier1Minutes: z.number().int().min(0).max(720).optional(),
  overtimeTier1RatePct: z.number().int().min(0).max(300).optional(),
  overtimeTier2RatePct: z.number().int().min(0).max(300).optional(),
  nightStartTime: timeStringSchema.optional(),
  nightEndTime: timeStringSchema.optional(),
  nightSurchargePct: z.number().int().min(0).max(300).optional(),
  nightShiftMinSharePct: z.number().int().min(1).max(100).optional(),
  minimumWage: z.number().positive().max(99_999_999).nullable().optional(),
  hourlyDivisor: z.number().int().min(1).max(744).optional(),
  payrollCurrency: z
    .string()
    .regex(/^[A-Z]{3}$/, "Codigo de moneda ISO 4217 (PEN, USD...)")
    .optional(),
});
export type UpdateCompanyInput = z.infer<typeof updateCompanySchema>;

/**
 * Sucursal con geocerca circular.
 *
 * Se usa un circulo (centro + radio) y no un poligono: cubre el 99 % de los
 * casos reales, se valida con una sola operacion de Haversine sin dependencias
 * geoespaciales, y es trivial de dibujar y entender en la UI de onboarding.
 */
export const branchSchema = z.object({
  name: z.string().trim().min(2).max(120),
  address: z.string().trim().max(255).optional(),
  latitude: latitudeSchema,
  longitude: longitudeSchema,
  /** Radio autorizado en metros. Minimo 20 m: por debajo, el ruido del GPS urbano
   * genera falsos rechazos constantes. */
  radiusMeters: z.number().int().min(20).max(5_000).default(100),
  timezone: timezoneSchema.optional(),
  isActive: z.boolean().default(true),
});
export type BranchInput = z.infer<typeof branchSchema>;

export const createBranchSchema = branchSchema;
export const updateBranchSchema = branchSchema.partial().extend({ id: idSchema });
export type UpdateBranchInput = z.infer<typeof updateBranchSchema>;

export const createUserSchema = z.object({
  email: emailSchema,
  fullName: z.string().trim().min(2).max(120),
  /** Documento de identidad o codigo interno. Unico dentro de la empresa. */
  employeeCode: z.string().trim().min(1).max(32),
  jobTitle: z.string().trim().max(120).optional(),
  role: z.nativeEnum(UserRole).default(UserRole.EMPLOYEE),
  phone: phoneSchema.optional(),
  branchId: idSchema.optional(),
  hiredAt: z.string().datetime({ offset: true }).optional(),
});
export type CreateUserInput = z.infer<typeof createUserSchema>;

export const updateUserSchema = createUserSchema
  .partial()
  .extend({ id: idSchema, status: z.nativeEnum(UserStatus).optional() });
export type UpdateUserInput = z.infer<typeof updateUserSchema>;

/** Invitacion de colaboradores por email y/o WhatsApp (onboarding self-service). */
export const inviteUsersSchema = z.object({
  invitations: z
    .array(
      z.object({
        email: emailSchema,
        fullName: z.string().trim().min(2).max(120),
        employeeCode: z.string().trim().min(1).max(32),
        role: z.nativeEnum(UserRole).default(UserRole.EMPLOYEE),
        phone: phoneSchema.optional(),
        branchId: idSchema.optional(),
      }),
    )
    .min(1)
    .max(200),
  channels: z.array(z.enum(["EMAIL", "WHATSAPP"])).min(1).default(["EMAIL"]),
});
export type InviteUsersInput = z.infer<typeof inviteUsersSchema>;

/** SUPER_ADMIN no es asignable desde la API de tenant: es un rol de plataforma. */
export const ASSIGNABLE_ROLES: readonly UserRole[] = [
  UserRole.EMPLOYEE,
  UserRole.SUPERVISOR,
  UserRole.HR_ADMIN,
];
