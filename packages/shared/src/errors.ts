/**
 * Codigos de error del dominio.
 *
 * Son estables y forman parte del contrato de la API: el movil y el dashboard
 * decidera que hacer segun el codigo, nunca segun el texto del mensaje.
 */
export const ErrorCode = {
  // Autenticacion / autorizacion
  UNAUTHENTICATED: "UNAUTHENTICATED",
  INVALID_CREDENTIALS: "INVALID_CREDENTIALS",
  TOKEN_EXPIRED: "TOKEN_EXPIRED",
  TOKEN_REVOKED: "TOKEN_REVOKED",
  FORBIDDEN: "FORBIDDEN",
  USER_SUSPENDED: "USER_SUSPENDED",

  // Aislamiento multi-tenant
  TENANT_CONTEXT_MISSING: "TENANT_CONTEXT_MISSING",
  CROSS_TENANT_ACCESS: "CROSS_TENANT_ACCESS",

  // Validacion
  VALIDATION_ERROR: "VALIDATION_ERROR",
  NOT_FOUND: "NOT_FOUND",
  CONFLICT: "CONFLICT",

  // Marcacion
  OUTSIDE_GEOFENCE: "OUTSIDE_GEOFENCE",
  MOCK_LOCATION_DETECTED: "MOCK_LOCATION_DETECTED",
  INVALID_PUNCH_SEQUENCE: "INVALID_PUNCH_SEQUENCE",
  DUPLICATE_PUNCH: "DUPLICATE_PUNCH",
  SELFIE_REQUIRED: "SELFIE_REQUIRED",
  SELFIE_NOT_UPLOADED: "SELFIE_NOT_UPLOADED",
  FACE_MATCH_FAILED: "FACE_MATCH_FAILED",
  NO_SHIFT_ASSIGNED: "NO_SHIFT_ASSIGNED",
  CLOCK_SKEW_TOO_LARGE: "CLOCK_SKEW_TOO_LARGE",

  // Suscripcion / limites
  SUBSCRIPTION_INACTIVE: "SUBSCRIPTION_INACTIVE",
  TRIAL_EXPIRED: "TRIAL_EXPIRED",
  EMPLOYEE_LIMIT_REACHED: "EMPLOYEE_LIMIT_REACHED",
  BRANCH_LIMIT_REACHED: "BRANCH_LIMIT_REACHED",
  FEATURE_NOT_IN_PLAN: "FEATURE_NOT_IN_PLAN",
  PAYMENT_REQUIRED: "PAYMENT_REQUIRED",

  // Infraestructura
  RATE_LIMITED: "RATE_LIMITED",
  STORAGE_ERROR: "STORAGE_ERROR",
  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export const ERROR_STATUS: Record<ErrorCode, number> = {
  UNAUTHENTICATED: 401,
  INVALID_CREDENTIALS: 401,
  TOKEN_EXPIRED: 401,
  TOKEN_REVOKED: 401,
  FORBIDDEN: 403,
  USER_SUSPENDED: 403,
  TENANT_CONTEXT_MISSING: 500,
  CROSS_TENANT_ACCESS: 403,
  VALIDATION_ERROR: 422,
  NOT_FOUND: 404,
  CONFLICT: 409,
  OUTSIDE_GEOFENCE: 422,
  MOCK_LOCATION_DETECTED: 422,
  INVALID_PUNCH_SEQUENCE: 409,
  DUPLICATE_PUNCH: 409,
  SELFIE_REQUIRED: 422,
  SELFIE_NOT_UPLOADED: 422,
  FACE_MATCH_FAILED: 422,
  NO_SHIFT_ASSIGNED: 422,
  CLOCK_SKEW_TOO_LARGE: 422,
  SUBSCRIPTION_INACTIVE: 402,
  TRIAL_EXPIRED: 402,
  EMPLOYEE_LIMIT_REACHED: 402,
  BRANCH_LIMIT_REACHED: 402,
  FEATURE_NOT_IN_PLAN: 402,
  PAYMENT_REQUIRED: 402,
  RATE_LIMITED: 429,
  STORAGE_ERROR: 502,
  INTERNAL_ERROR: 500,
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly details?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.statusCode = ERROR_STATUS[code];
    this.details = details;
    Error.captureStackTrace?.(this, AppError);
  }

  toJSON() {
    return {
      success: false as const,
      error: { code: this.code, message: this.message, details: this.details },
    };
  }
}

/** Se lanza cuando una consulta a un modelo con tenant corre sin contexto de tenant. */
export class TenantIsolationError extends AppError {
  constructor(model: string, operation: string) {
    super(
      ErrorCode.TENANT_CONTEXT_MISSING,
      `Consulta bloqueada: "${operation}" sobre "${model}" se ejecuto sin contexto de tenant. ` +
        `Envuelve la operacion en runWithTenant() o usa getSystemClient() si es un proceso de plataforma.`,
      { model, operation },
    );
    this.name = "TenantIsolationError";
  }
}
