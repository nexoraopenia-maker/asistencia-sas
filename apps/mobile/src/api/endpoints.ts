import type {
  AuthTokens,
  BatchPunchResponse,
  CreatePunchInput,
  PresignedUrlResponse,
  PunchResult,
  WeeklySchedule,
} from "@scire/shared";
import { apiRequest } from "./client";

/**
 * Superficie de la API que consume el movil.
 *
 * Los tipos vienen de `@scire/shared`, el mismo paquete que usa el backend:
 * si un endpoint cambia de forma, el error aparece aqui al compilar y no en
 * produccion con un `undefined` en pantalla.
 */

export interface AuthenticatedUser {
  id: string;
  email: string;
  fullName: string;
  employeeCode: string;
  jobTitle: string | null;
  role: string;
  companyId: string;
  companyName: string;
  branchId: string | null;
  avatarKey: string | null;
}

export interface LoginResponse {
  user: AuthenticatedUser;
  tokens: AuthTokens;
}

export const authApi = {
  login: (email: string, password: string, deviceId: string, deviceName: string) =>
    apiRequest<LoginResponse>("/api/v1/auth/login", {
      method: "POST",
      anonymous: true,
      body: { email, password, deviceId, deviceName },
    }),

  /**
   * Desbloqueo biometrico. El servidor no recibe datos biometricos: la huella
   * o Face ID ya liberaron el refresh token del keychain, y esto es un
   * refresco normal con constancia de que el sistema operativo valido al usuario.
   */
  biometric: (refreshToken: string, deviceId: string) =>
    apiRequest<AuthTokens>("/api/v1/auth/biometric", {
      method: "POST",
      anonymous: true,
      body: { refreshToken, deviceId, biometricVerified: true },
    }),

  me: () => apiRequest<AuthenticatedUser>("/api/v1/auth/me"),

  logout: (refreshToken: string) =>
    apiRequest<{ revoked: boolean }>("/api/v1/auth/logout", {
      method: "POST",
      anonymous: true,
      body: { refreshToken },
    }),
};

export interface TodayPunch {
  id: string;
  punchType: "IN" | "OUT" | "LUNCH_START" | "LUNCH_END";
  time: string;
  serverTimestamp: string;
  isVerified: boolean;
  hasAlert: boolean;
  tardinessMinutes: number;
}

export const punchApi = {
  presignedUrl: (input: {
    punchType: string;
    contentType: string;
    contentLength: number;
  }) =>
    apiRequest<PresignedUrlResponse>("/api/v1/punch/presigned-url", {
      method: "POST",
      body: input,
    }),

  create: (input: CreatePunchInput) =>
    apiRequest<PunchResult>("/api/v1/punch", { method: "POST", body: input }),

  batch: (punches: CreatePunchInput[]) =>
    apiRequest<BatchPunchResponse>("/api/v1/punch/batch", {
      method: "POST",
      body: { punches },
      // Un lote acumulado tras un dia sin cobertura tarda mas que una peticion
      // normal: se le da margen antes de darlo por perdido.
      timeoutMs: 45_000,
    }),

  today: () => apiRequest<TodayPunch[]>("/api/v1/punch/today"),

  history: (params: { page?: number; pageSize?: number } = {}) => {
    const query = new URLSearchParams({
      page: String(params.page ?? 1),
      pageSize: String(params.pageSize ?? 25),
    });
    return apiRequest<{
      items: {
        id: string;
        punchType: string;
        serverTimestamp: string;
        verificationStatus: string;
        isMockLocation: boolean;
        isWithinGeofence: boolean | null;
        tardinessMinutes: number;
        hasSelfie: boolean;
        branch: { id: string; name: string };
      }[];
      total: number;
      totalPages: number;
      page: number;
    }>(`/api/v1/punch?${query.toString()}`);
  },
};

export const shiftsApi = {
  week: (weekOf: string) =>
    apiRequest<WeeklySchedule>(`/api/v1/shifts/week?weekOf=${weekOf}`),
};
