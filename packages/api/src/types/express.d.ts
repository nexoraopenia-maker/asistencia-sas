import type { AccessTokenPayload } from "@scire/shared";

declare global {
  namespace Express {
    interface Request {
      /**
       * Identidad autenticada, poblada por `requireAuth`.
       *
       * `companyId` viene FIRMADO en el access token. Es la unica fuente
       * valida del tenant: nunca se lee del body, la query ni una cabecera.
       */
      auth?: AccessTokenPayload;
      /**
       * Reloj biometrico autenticado por `X-Device-Key`. Excluyente con
       * `auth`: un dispositivo no es un usuario y no tiene rol.
       */
      device?: { id: string; companyId: string; branchId: string | null; name: string };
    }
  }
}

export {};
