import { AppError, ErrorCode } from "@scire/shared";
import type { Request, RequestHandler, Response } from "express";
import { loadConfig } from "../config.js";
import { consumeRateLimit, type RateLimitRule } from "../lib/rate-limit.js";

/**
 * Middleware de rate limiting.
 *
 * Emite las cabeceras del borrador RFC de RateLimit (`RateLimit-Limit`,
 * `RateLimit-Remaining`, `RateLimit-Reset`) y `Retry-After` con el 429, que es
 * lo que exige la RFC 6585. Se envian SIEMPRE, no solo al bloquear: un cliente
 * bien hecho baja el ritmo antes de chocar, y eso es preferible a que choque.
 */

export interface RateLimitOptions extends RateLimitRule {
  /** Prefijo de la clave. Separa los contadores de cada endpoint. */
  bucket: string;
  /**
   * De que se deriva el limite. Por defecto, la IP.
   * Devolver `null` desactiva el limite para esa peticion.
   */
  keyBy?: (req: Request) => string | null;
  /** Mensaje mostrado al cliente al bloquear. */
  message?: string;
}

/**
 * IP real del cliente.
 *
 * `app.set("trust proxy", 1)` hace que Express resuelva `req.ip` desde
 * `X-Forwarded-For` con UN salto de proxy. Con Easypanel/Traefik delante eso
 * es correcto; con dos capas de proxy habria que subir el numero, o un cliente
 * podria falsear su IP anadiendo la cabecera y saltarse el limite.
 */
function clientIp(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? "desconocida";
}

/** Limita por usuario autenticado; si no lo hay, por IP. */
export function byUserOrIp(req: Request): string {
  return req.auth ? `u:${req.auth.sub}` : `ip:${clientIp(req)}`;
}

/**
 * Limita por IP **y** por identidad declarada.
 *
 * Para el login hacen falta las dos: solo por IP, una botnet prueba una
 * contrasena por IP contra la misma cuenta sin tocar el limite; solo por email,
 * un atacante recorre miles de correos desde una IP. El middleware aplica la
 * mas restrictiva de las dos.
 */
export function byIp(req: Request): string {
  return `ip:${clientIp(req)}`;
}

function applyHeaders(res: Response, result: {
  limit: number;
  remaining: number;
  resetAt: Date;
}): void {
  const resetSeconds = Math.max(0, Math.ceil((result.resetAt.getTime() - Date.now()) / 1_000));
  res.setHeader("RateLimit-Limit", String(result.limit));
  res.setHeader("RateLimit-Remaining", String(result.remaining));
  res.setHeader("RateLimit-Reset", String(resetSeconds));
  // Nombres heredados: muchos SDK y proxies solo entienden estos.
  res.setHeader("X-RateLimit-Limit", String(result.limit));
  res.setHeader("X-RateLimit-Remaining", String(result.remaining));
}

export function rateLimit(options: RateLimitOptions): RequestHandler {
  const { bucket, limit, windowSeconds, keyBy = byIp, message } = options;

  return (req, res, next) => {
    void (async () => {
      try {
        if (!loadConfig().RATE_LIMIT_ENABLED) return next();

        const subject = keyBy(req);
        if (subject === null) return next();

        const result = await consumeRateLimit(`rl:${bucket}:${subject}`, { limit, windowSeconds });
        applyHeaders(res, result);

        if (!result.allowed) {
          res.setHeader("Retry-After", String(result.retryAfterSeconds));
          throw new AppError(
            ErrorCode.RATE_LIMITED,
            message ?? "Demasiadas peticiones. Intentalo de nuevo en unos segundos.",
            { retryAfterSeconds: result.retryAfterSeconds, limit },
          );
        }

        next();
      } catch (error) {
        next(error);
      }
    })();
  };
}

/**
 * Aplica varios limites a la vez y bloquea con el primero que se agote.
 *
 * El login lo usa para exigir simultaneamente un tope por IP y otro por cuenta.
 */
export function rateLimitAll(...limiters: RequestHandler[]): RequestHandler {
  return (req, res, next) => {
    let index = 0;
    const run = (error?: unknown): void => {
      if (error) return next(error);
      const limiter = limiters[index++];
      if (!limiter) return next();
      limiter(req, res, run);
    };
    run();
  };
}

/**
 * Limite por credencial en los endpoints de autenticacion.
 *
 * La clave sale del correo enviado en el cuerpo, normalizado. Si no viene, se
 * omite: la validacion de Zod ya rechazara la peticion.
 */
export function byLoginIdentity(req: Request): string | null {
  const body = req.body as { email?: unknown } | undefined;
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : null;
  return email ? `id:${email}` : null;
}
