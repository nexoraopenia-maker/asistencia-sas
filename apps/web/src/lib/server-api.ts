import { cookies } from "next/headers";
import {
  ACCESS_COOKIE,
  API_URL,
  REFRESH_COOKIE,
  getAccessToken,
  getRefreshToken,
} from "./session";

/**
 * Llamadas a la API desde el servidor de Next (route handlers).
 *
 * Refresca el access token de forma transparente cuando caduca y devuelve los
 * tokens nuevos para que el llamante los vuelva a sellar en las cookies. El
 * refresco NO se hace en Server Components: alli no se pueden escribir
 * cookies, y un refresco cuyo resultado se pierde acabaria disparando la
 * deteccion de reutilizacion del backend contra el propio usuario.
 */

export interface ApiCallResult {
  status: number;
  body: unknown;
  /** Presente solo si hubo rotacion: hay que resellar las cookies. */
  rotatedTokens?: { accessToken: string; refreshToken: string };
}

async function callApi(
  path: string,
  init: RequestInit,
  accessToken: string | null,
): Promise<Response> {
  return fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    },
    cache: "no-store",
  });
}

export async function apiFetch(path: string, init: RequestInit = {}): Promise<ApiCallResult> {
  const accessToken = await getAccessToken();
  let response = await callApi(path, init, accessToken);
  let rotatedTokens: ApiCallResult["rotatedTokens"];

  if (response.status === 401) {
    const refreshToken = await getRefreshToken();
    if (refreshToken) {
      const refreshed = await fetch(`${API_URL}/api/v1/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken }),
        cache: "no-store",
      });

      if (refreshed.ok) {
        const payload = await refreshed.json();
        rotatedTokens = {
          accessToken: payload.data.accessToken,
          refreshToken: payload.data.refreshToken,
        };
        response = await callApi(path, init, rotatedTokens.accessToken);
      }
    }
  }

  const body = await response.json().catch(() => null);
  return { status: response.status, body, rotatedTokens };
}

/**
 * Lectura desde un Server Component.
 *
 * Sin refresco: si el access token caduco devuelve null y la interfaz cae a su
 * estado vacio. El cliente rehidratara los datos a traves del proxy, que si
 * puede rotar cookies.
 */
export async function serverFetch<T>(path: string): Promise<T | null> {
  const accessToken = (await cookies()).get(ACCESS_COOKIE)?.value;
  if (!accessToken) return null;
  try {
    const response = await callApi(path, { method: "GET" }, accessToken);
    if (!response.ok) return null;
    const payload = await response.json();
    return payload.data as T;
  } catch {
    return null;
  }
}

export { ACCESS_COOKIE, REFRESH_COOKIE };
