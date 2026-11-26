import { NextResponse } from "next/server";
import { API_URL, clearSessionCookies, getRefreshToken } from "../../../../lib/session";

export const runtime = "nodejs";

export async function POST(): Promise<NextResponse> {
  const refreshToken = await getRefreshToken();

  // Se avisa a la API para revocar la sesion en el servidor, pero sin bloquear
  // el cierre local: si la API no responde, las cookies se borran igual.
  if (refreshToken) {
    await fetch(`${API_URL}/api/v1/auth/logout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken }),
      cache: "no-store",
    }).catch(() => {});
  }

  await clearSessionCookies();
  return NextResponse.json({ success: true });
}
