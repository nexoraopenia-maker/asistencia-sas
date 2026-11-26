import { createHash, randomBytes } from "node:crypto";
import { AppError, ErrorCode, type AccessTokenPayload, type UserRole } from "@scire/shared";
import jwt from "jsonwebtoken";
import { loadConfig } from "../config.js";

/**
 * Emision y verificacion de tokens.
 *
 * - **Access token**: JWT de vida corta (15 min). Lleva `companyId` firmado:
 *   es la raiz del aislamiento multi-tenant. No se puede revocar antes de que
 *   expire — de ahi que la vida sea corta.
 * - **Refresh token**: JWT de vida larga (30 dias) ligado a una fila `Session`.
 *   Se guarda HASHEADO en la base, nunca en claro: quien vuelque la tabla de
 *   sesiones no obtiene tokens utilizables.
 *
 * El doble mecanismo (firma + fila en base) es deliberado: la firma evita el
 * viaje a la base para un token manipulado, y la fila permite revocar un
 * dispositivo concreto sin esperar a la expiracion.
 */

export interface RefreshTokenPayload {
  sub: string;
  companyId: string;
  /** Id de la fila Session. Es lo que permite revocar este dispositivo. */
  sid: string;
  /** Marca el token como refresh para que no pueda usarse como access token. */
  typ: "refresh";
  iat: number;
  exp: number;
}

export interface IssueTokenInput {
  userId: string;
  companyId: string;
  role: UserRole;
  sessionId: string;
}

export function signAccessToken(input: IssueTokenInput): string {
  const config = loadConfig();
  return jwt.sign(
    { companyId: input.companyId, role: input.role, sid: input.sessionId },
    config.JWT_ACCESS_SECRET,
    { subject: input.userId, expiresIn: config.JWT_ACCESS_TTL } as jwt.SignOptions,
  );
}

export function signRefreshToken(input: IssueTokenInput): string {
  const config = loadConfig();
  return jwt.sign(
    { companyId: input.companyId, sid: input.sessionId, typ: "refresh" },
    config.JWT_REFRESH_SECRET,
    { subject: input.userId, expiresIn: config.JWT_REFRESH_TTL } as jwt.SignOptions,
  );
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  const config = loadConfig();
  try {
    const payload = jwt.verify(token, config.JWT_ACCESS_SECRET) as AccessTokenPayload & {
      typ?: string;
    };
    // Un refresh token esta firmado con otro secreto, pero la comprobacion
    // explicita protege ante una futura unificacion de secretos por error.
    if (payload.typ === "refresh") {
      throw new AppError(ErrorCode.UNAUTHENTICATED, "Tipo de token invalido");
    }
    return payload;
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (error instanceof jwt.TokenExpiredError) {
      throw new AppError(ErrorCode.TOKEN_EXPIRED, "El token de acceso ha expirado");
    }
    throw new AppError(ErrorCode.UNAUTHENTICATED, "Token de acceso invalido");
  }
}

export function verifyRefreshToken(token: string): RefreshTokenPayload {
  const config = loadConfig();
  try {
    const payload = jwt.verify(token, config.JWT_REFRESH_SECRET) as RefreshTokenPayload;
    if (payload.typ !== "refresh") {
      throw new AppError(ErrorCode.UNAUTHENTICATED, "Tipo de token invalido");
    }
    return payload;
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (error instanceof jwt.TokenExpiredError) {
      throw new AppError(ErrorCode.TOKEN_EXPIRED, "La sesion ha expirado, vuelve a iniciar sesion");
    }
    throw new AppError(ErrorCode.UNAUTHENTICATED, "Token de refresco invalido");
  }
}

/**
 * Hash del refresh token para guardarlo en `Session.refreshTokenHash`.
 *
 * SHA-256 y no bcrypt a proposito: el token ya es un secreto de 256 bits
 * generado por el servidor, no una contrasena humana adivinable, asi que no
 * necesita un hash lento — y el refresh esta en el camino caliente de arranque
 * de la app movil, donde bcrypt anadiria cientos de milisegundos.
 */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Token opaco de un solo uso para invitaciones y reseteos de contrasena. */
export function generateOpaqueToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Segundos de vida del access token, para el campo `expiresIn` de la respuesta. */
export function accessTokenTtlSeconds(): number {
  const ttl = loadConfig().JWT_ACCESS_TTL;
  const match = /^(\d+)([smhd])$/.exec(ttl);
  if (!match) return 900;
  const multipliers: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86_400 };
  return Number(match[1]) * (multipliers[match[2]!] ?? 60);
}

/** Instante de expiracion del refresh token, para `Session.expiresAt`. */
export function refreshTokenExpiry(): Date {
  const ttl = loadConfig().JWT_REFRESH_TTL;
  const match = /^(\d+)([smhd])$/.exec(ttl);
  const seconds = match
    ? Number(match[1]) * ({ s: 1, m: 60, h: 3600, d: 86_400 }[match[2]!] ?? 86_400)
    : 30 * 86_400;
  return new Date(Date.now() + seconds * 1000);
}
