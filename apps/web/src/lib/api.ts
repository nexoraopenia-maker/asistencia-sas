"use client";

/**
 * Cliente de datos del navegador.
 *
 * Habla SIEMPRE con el proxy `/api/proxy`, nunca con la API directamente: el
 * token de sesion vive en una cookie httpOnly que este codigo no puede leer,
 * que es exactamente lo que se busca. Un XSS aqui no puede exfiltrar la
 * credencial.
 */

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(status: number, code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export async function api<T>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const response = await fetch(`/api/proxy${path}`, {
    method: init.method ?? "GET",
    ...(init.body ? { headers: { "Content-Type": "application/json" } } : {}),
    ...(init.body ? { body: JSON.stringify(init.body) } : {}),
  });

  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    const error = payload?.error ?? {};
    // Sesion muerta: el proxy ya limpio las cookies, solo queda devolver al
    // login. Una recarga completa evita quedarse con estado obsoleto en memoria.
    if (response.status === 401 && typeof window !== "undefined") {
      window.location.href = "/login";
    }
    throw new ApiError(
      response.status,
      error.code ?? "UNKNOWN",
      error.message ?? "No se pudo completar la operacion",
      error.details,
    );
  }

  return payload.data as T;
}

/** Construye un query string omitiendo los valores vacios. */
export function qs(params: Record<string, string | number | boolean | undefined | null>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") search.set(key, String(value));
  }
  const result = search.toString();
  return result ? `?${result}` : "";
}
