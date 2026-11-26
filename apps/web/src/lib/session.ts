import { cookies } from "next/headers";
import type { UserRole } from "@scire/shared";

/**
 * Sesion del dashboard.
 *
 * Los tokens viven en cookies **httpOnly**: nunca son legibles desde
 * JavaScript. Guardarlos en localStorage, que es lo habitual, convierte
 * cualquier XSS —una dependencia comprometida, un nombre de empleado que se
 * renderiza sin escapar— en un robo de sesion completo. Con httpOnly, un XSS
 * puede hacer peticiones en nombre del usuario mientras la pestana esta
 * abierta, pero no puede exfiltrar la credencial.
 *
 * El navegador nunca habla directo con la API: pasa por el proxy BFF de
 * `/api/proxy`, que es quien adjunta el Bearer.
 */

export const ACCESS_COOKIE = "scire_at";
export const REFRESH_COOKIE = "scire_rt";
/** Datos no sensibles para pintar la interfaz sin ir a la API en cada render. */
export const PROFILE_COOKIE = "scire_profile";

export interface SessionProfile {
  id: string;
  fullName: string;
  email: string;
  role: UserRole;
  companyId: string;
  companyName: string;
  employeeCode: string;
  jobTitle: string | null;
  branchId: string | null;
}

const isProduction = process.env.NODE_ENV === "production";

const baseCookie = {
  httpOnly: true,
  sameSite: "lax" as const,
  // `secure` solo en produccion: en desarrollo se sirve por HTTP y el
  // navegador descartaria la cookie en silencio.
  secure: isProduction,
  path: "/",
};

/** 15 min de access token, con un minuto de margen para el reloj del cliente. */
const ACCESS_MAX_AGE = 15 * 60 - 60;
const REFRESH_MAX_AGE = 30 * 86_400;

export async function setSessionCookies(tokens: {
  accessToken: string;
  refreshToken: string;
}): Promise<void> {
  const jar = await cookies();
  jar.set(ACCESS_COOKIE, tokens.accessToken, { ...baseCookie, maxAge: ACCESS_MAX_AGE });
  jar.set(REFRESH_COOKIE, tokens.refreshToken, { ...baseCookie, maxAge: REFRESH_MAX_AGE });
}

export async function setProfileCookie(profile: SessionProfile): Promise<void> {
  const jar = await cookies();
  // No es httpOnly a proposito: el layout la lee para pintar el nombre y el
  // rol. No contiene nada que sirva para autenticarse.
  jar.set(PROFILE_COOKIE, encodeURIComponent(JSON.stringify(profile)), {
    ...baseCookie,
    httpOnly: false,
    maxAge: REFRESH_MAX_AGE,
  });
}

export async function clearSessionCookies(): Promise<void> {
  const jar = await cookies();
  for (const name of [ACCESS_COOKIE, REFRESH_COOKIE, PROFILE_COOKIE]) {
    jar.set(name, "", { ...baseCookie, httpOnly: name !== PROFILE_COOKIE, maxAge: 0 });
  }
}

export async function getSessionProfile(): Promise<SessionProfile | null> {
  const raw = (await cookies()).get(PROFILE_COOKIE)?.value;
  if (!raw) return null;
  try {
    return JSON.parse(decodeURIComponent(raw)) as SessionProfile;
  } catch {
    return null;
  }
}

export async function getRefreshToken(): Promise<string | null> {
  return (await cookies()).get(REFRESH_COOKIE)?.value ?? null;
}

export async function getAccessToken(): Promise<string | null> {
  return (await cookies()).get(ACCESS_COOKIE)?.value ?? null;
}

export const API_URL = process.env.API_URL ?? "http://localhost:4000";
