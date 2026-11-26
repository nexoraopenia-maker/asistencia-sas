import { z } from "zod";
import { UserRole } from "../enums.js";
import { emailSchema, idSchema, passwordSchema, phoneSchema, timezoneSchema } from "./common.js";

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, "La contrasena es obligatoria").max(128),
  /** Identificador estable del dispositivo; ata el refresh token a un aparato. */
  deviceId: z.string().max(128).optional(),
  deviceName: z.string().max(128).optional(),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const refreshTokenSchema = z.object({
  refreshToken: z.string().min(1),
});
export type RefreshTokenInput = z.infer<typeof refreshTokenSchema>;

/**
 * Login biometrico del movil.
 *
 * El desbloqueo por huella/Face ID ocurre en el dispositivo: solo libera el
 * refresh token guardado en el keychain seguro. El servidor NUNCA recibe datos
 * biometricos — recibe el mismo refresh token de siempre mas la constancia de
 * que el sistema operativo valido al usuario.
 */
export const biometricAuthSchema = z.object({
  refreshToken: z.string().min(1),
  deviceId: z.string().min(1).max(128),
  biometricVerified: z.literal(true),
});
export type BiometricAuthInput = z.infer<typeof biometricAuthSchema>;

/** Alta de una empresa nueva (onboarding self-service). Crea Company + HR_ADMIN. */
export const registerCompanySchema = z.object({
  companyName: z.string().trim().min(2).max(120),
  /** Identificador fiscal (RUC, CUIT, NIT...). */
  taxId: z.string().trim().min(5).max(32).optional(),
  timezone: timezoneSchema.default("America/Lima"),
  adminFullName: z.string().trim().min(2).max(120),
  adminEmail: emailSchema,
  adminPassword: passwordSchema,
  adminPhone: phoneSchema.optional(),
  acceptedTerms: z.literal(true, {
    errorMap: () => ({ message: "Debes aceptar los terminos y condiciones" }),
  }),
});
export type RegisterCompanyInput = z.infer<typeof registerCompanySchema>;

/** Un empleado invitado completa su registro con el token del email/WhatsApp. */
export const acceptInvitationSchema = z.object({
  token: z.string().min(16),
  password: passwordSchema,
  fullName: z.string().trim().min(2).max(120).optional(),
});
export type AcceptInvitationInput = z.infer<typeof acceptInvitationSchema>;

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1),
    newPassword: passwordSchema,
  })
  .refine((v) => v.currentPassword !== v.newPassword, {
    message: "La nueva contrasena debe ser distinta de la actual",
    path: ["newPassword"],
  });
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

/** Payload del access token JWT. `companyId` viaja firmado: es la raiz del aislamiento. */
export interface AccessTokenPayload {
  /** userId */
  sub: string;
  companyId: string;
  role: UserRole;
  /** Id de sesion; permite revocar un dispositivo concreto. */
  sid: string;
  iat: number;
  exp: number;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  /** Segundos de vida del access token. */
  expiresIn: number;
  tokenType: "Bearer";
}

export const revokeSessionSchema = z.object({
  sessionId: idSchema,
});
export type RevokeSessionInput = z.infer<typeof revokeSessionSchema>;
