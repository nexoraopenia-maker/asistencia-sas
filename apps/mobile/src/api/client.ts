import Constants from "expo-constants";
import { ApiError, NetworkError } from "../lib/errors";
import { clearTokens, getTokens, saveTokens, type StoredTokens } from "../lib/storage";

export { ApiError, NetworkError };

/**
 * Cliente HTTP contra la API de Scire 360 Chronos.
 *
 * Resuelve tres cosas que un `fetch` pelado no cubre:
 *  1. Adjunta el access token y refresca cuando caduca.
 *  2. Serializa el refresco (single-flight) — ver nota abajo.
 *  3. Distingue "fallo de red" de "el servidor rechazo la peticion", que es la
 *     diferencia entre encolar una marcacion o mostrarle un error al empleado.
 */

const API_URL =
  process.env.EXPO_PUBLIC_API_URL ??
  (Constants.expoConfig?.extra?.apiUrl as string | undefined) ??
  "http://localhost:4000";


type SessionExpiredHandler = () => void;
let onSessionExpired: SessionExpiredHandler = () => {};

/** El AuthContext registra aqui como cerrar sesion cuando el refresco falla. */
export function setSessionExpiredHandler(handler: SessionExpiredHandler): void {
  onSessionExpired = handler;
}

/**
 * Refresco en vuelo, compartido por todas las peticiones que se topen con un
 * 401 a la vez.
 *
 * Esto NO es una optimizacion, es una necesidad. El backend detecta la
 * reutilizacion de refresh tokens y responde revocando TODAS las sesiones del
 * usuario. Si la pantalla de inicio dispara tres peticiones en paralelo y las
 * tres caducan a la vez, tres refrescos con el mismo token se leerian como un
 * robo de credenciales y echarian al empleado de la aplicacion.
 */
let refreshInFlight: Promise<StoredTokens | "unreachable" | null> | null = null;

async function refreshTokens(): Promise<StoredTokens | "unreachable" | null> {
  refreshInFlight ??= (async () => {
    try {
      const stored = await getTokens();
      if (!stored) return null;

      const response = await fetch(`${API_URL}/api/v1/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken: stored.refreshToken }),
      });

      // Un 500 o un 429 no invalidan la sesion: solo un rechazo explicito.
      if (response.status >= 500 || response.status === 429) return "unreachable";
      if (!response.ok) {
        await clearTokens();
        onSessionExpired();
        return null;
      }

      const body = await response.json();
      const tokens: StoredTokens = {
        accessToken: body.data.accessToken,
        refreshToken: body.data.refreshToken,
      };
      await saveTokens(tokens);
      return tokens;
    } catch {
      // Fallo de red durante el refresco: la sesion sigue siendo valida, solo
      // no hay cobertura. No se borran los tokens.
      return "unreachable";
    } finally {
      // Se libera en el siguiente tick para que las peticiones que ya estaban
      // esperando reciban este mismo resultado.
      setTimeout(() => {
        refreshInFlight = null;
      }, 0);
    }
  })();

  return refreshInFlight;
}

export interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  /** Peticiones publicas (login, registro) que no llevan token. */
  anonymous?: boolean;
  /** Corta la peticion pasado este tiempo. Evita que la UI se quede colgada. */
  timeoutMs?: number;
}

async function rawRequest(
  path: string,
  options: RequestOptions,
  accessToken: string | null,
): Promise<Response> {
  const { method = "GET", body, timeoutMs = 15_000 } = options;

  try {
    return await fetch(`${API_URL}${path}`, {
      method,
      headers: {
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    // fetch solo lanza por fallo de red o timeout; cualquier respuesta HTTP,
    // incluido un 500, llega como Response.
    throw new NetworkError();
  }
}

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const stored = options.anonymous ? null : await getTokens();
  let response = await rawRequest(path, options, stored?.accessToken ?? null);

  if (response.status === 401 && !options.anonymous && stored) {
    const refreshed = await refreshTokens();
    if (refreshed === "unreachable") throw new NetworkError();
    if (refreshed) {
      response = await rawRequest(path, options, refreshed.accessToken);
    }
  }

  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    const error = payload?.error ?? {};
    if (response.status === 401) onSessionExpired();
    throw new ApiError(
      response.status,
      error.code ?? "UNKNOWN",
      error.message ?? "No se pudo completar la operacion",
      error.details,
    );
  }

  return payload.data as T;
}

export { API_URL };
