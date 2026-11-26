import { NextResponse, type NextRequest } from "next/server";
import { apiFetch } from "../../../../lib/server-api";
import { clearSessionCookies, setSessionCookies } from "../../../../lib/session";

/**
 * Proxy BFF hacia la API.
 *
 * El navegador llama a `/api/proxy/v1/...` sin token alguno; este handler lee
 * la cookie httpOnly, adjunta el Bearer y, si hace falta, refresca y resella
 * las cookies. Asi el token de sesion no existe en el contexto de JavaScript
 * del navegador en ningun momento.
 *
 * Todos los verbos comparten implementacion: el proxy no interpreta el cuerpo,
 * solo lo reenvia.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function handle(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> },
): Promise<NextResponse> {
  const { path } = await context.params;
  const search = request.nextUrl.search;
  const target = `/api/${path.join("/")}${search}`;

  const method = request.method;
  const hasBody = method !== "GET" && method !== "DELETE";
  const body = hasBody ? await request.text() : undefined;

  const result = await apiFetch(target, {
    method,
    ...(body ? { body, headers: { "Content-Type": "application/json" } } : {}),
  });

  const response = NextResponse.json(result.body ?? {}, { status: result.status });

  if (result.rotatedTokens) {
    await setSessionCookies(result.rotatedTokens);
  }
  // 401 tras haber intentado refrescar significa sesion muerta: se limpian las
  // cookies para que el middleware devuelva al login en la siguiente
  // navegacion, en vez de dejar al usuario en un panel que no carga nada.
  if (result.status === 401) {
    await clearSessionCookies();
  }

  return response;
}

export const GET = handle;
export const POST = handle;
export const PATCH = handle;
export const PUT = handle;
export const DELETE = handle;
