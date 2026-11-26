import { AppError, ErrorCode, type ApiResponse } from "@scire/shared";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { ZodError, type TypeOf, type ZodTypeAny } from "zod";

/**
 * Express 4 no captura los rechazos de un handler `async`: sin este envoltorio,
 * una promesa rechazada se pierde y el request queda colgado hasta el timeout.
 */
export function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    handler(req, res, next).catch(next);
  };
}

export function ok<T>(res: Response, data: T, status = 200): Response {
  const body: ApiResponse<T> = { success: true, data };
  return res.status(status).json(body);
}

/** Convierte un ZodError en el mapa `campo -> [mensajes]` del contrato de la API. */
function zodDetails(error: ZodError): Record<string, string[]> {
  const details: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".") || "_";
    (details[key] ??= []).push(issue.message);
  }
  return details;
}

/**
 * Valida el cuerpo del request contra un esquema Zod y devuelve el valor
 * ya tipado. Lanza `AppError` con el detalle por campo si no valida.
 *
 * Es generico sobre el ESQUEMA y no sobre el tipo resultado: un esquema con
 * `.default()` tiene un tipo de entrada distinto del de salida, y fijar solo
 * el de salida haria que TypeScript rechazara justo los campos opcionales que
 * el default existe para rellenar.
 */
export function parseBody<S extends ZodTypeAny>(schema: S, body: unknown): TypeOf<S> {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new AppError(
      ErrorCode.VALIDATION_ERROR,
      "Los datos enviados no son validos",
      zodDetails(result.error),
    );
  }
  return result.data;
}

/** Igual que `parseBody`, para query strings. */
export function parseQuery<S extends ZodTypeAny>(schema: S, query: unknown): TypeOf<S> {
  const result = schema.safeParse(query);
  if (!result.success) {
    throw new AppError(
      ErrorCode.VALIDATION_ERROR,
      "Los parametros de consulta no son validos",
      zodDetails(result.error),
    );
  }
  return result.data;
}

/**
 * Manejador de errores final.
 *
 * Traduce `AppError` a su codigo HTTP y jamas filtra un stack trace ni un
 * mensaje interno al cliente: un error no controlado siempre sale como
 * INTERNAL_ERROR generico y se registra completo en el servidor.
 */
export function errorHandler(
  error: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (error instanceof AppError) {
    // Se reenvia `details` INTEGRO. Filtrarlo por un unico formato conocido
    // vaciaria de sentido el contexto que adjunta cada error: sin
    // `distanceMeters` el movil no puede decirle al empleado cuanto le falta
    // para entrar en la geocerca, y sin `recordId` la cola offline no puede
    // conciliar un duplicado.
    res.status(error.statusCode).json({
      success: false,
      error: {
        code: error.code,
        message: error.message,
        ...(error.details ? { details: error.details } : {}),
      },
    });
    return;
  }

  if (error instanceof ZodError) {
    res.status(422).json({
      success: false,
      error: {
        code: ErrorCode.VALIDATION_ERROR,
        message: "Los datos enviados no son validos",
        details: zodDetails(error),
      },
    });
    return;
  }

  console.error("[api] error no controlado", error);
  res.status(500).json({
    success: false,
    error: { code: ErrorCode.INTERNAL_ERROR, message: "Error interno del servidor" },
  });
}
