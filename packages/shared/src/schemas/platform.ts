import { z } from "zod";
import { AccountStatus, SubscriptionTier } from "../enums.js";
import { emailSchema, passwordSchema, phoneSchema, timezoneSchema } from "./common.js";

/**
 * Consola de plataforma (SUPER_ADMIN).
 *
 * Son operaciones TRANSVERSALES a los tenants: el `companyId` objetivo viaja en
 * la ruta, no en el token. Por eso estos esquemas viven aparte de los de
 * `company.ts`, que solo actuan sobre la empresa del propio usuario.
 */

export const listTenantsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  /** Coincidencia parcial sobre nombre, slug o RUC. */
  search: z.string().trim().max(120).optional(),
  status: z.nativeEnum(AccountStatus).optional(),
  tier: z.nativeEnum(SubscriptionTier).optional(),
});
export type ListTenantsQuery = z.infer<typeof listTenantsQuerySchema>;

/**
 * Alta asistida de una empresa por el operador de la plataforma.
 *
 * A diferencia del onboarding self-service, el plan se fija aqui y la cuenta
 * nace ACTIVE: es una venta cerrada fuera de la pasarela de pago.
 */
export const createTenantSchema = z.object({
  companyName: z.string().trim().min(2).max(120),
  taxId: z.string().trim().min(5).max(32).optional(),
  timezone: timezoneSchema.default("America/Lima"),
  tier: z.nativeEnum(SubscriptionTier),
  adminFullName: z.string().trim().min(2).max(120),
  adminEmail: emailSchema,
  /**
   * Si se omite, el servidor genera una contrasena temporal fuerte y la
   * devuelve UNA sola vez en la respuesta.
   */
  adminPassword: passwordSchema.optional(),
  adminPhone: phoneSchema.optional(),
});
export type CreateTenantInput = z.infer<typeof createTenantSchema>;

/**
 * Suspension o reactivacion manual.
 *
 * El motivo es obligatorio: queda en el AuditLog del tenant y es lo unico que
 * explicara despues por que una cuenta se corto sin un evento de la pasarela.
 */
export const setTenantStatusSchema = z.object({
  status: z.enum([AccountStatus.ACTIVE, AccountStatus.SUSPENDED]),
  reason: z.string().trim().min(3, "Indica el motivo").max(500),
});
export type SetTenantStatusInput = z.infer<typeof setTenantStatusSchema>;
