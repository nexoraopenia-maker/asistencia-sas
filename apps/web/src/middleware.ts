import { NextResponse, type NextRequest } from "next/server";

/**
 * Guardia de rutas.
 *
 * Solo comprueba la PRESENCIA del refresh token, no su validez: verificar la
 * firma exigiria el secreto JWT en el edge runtime, y un token caducado ya lo
 * rechaza la API en la primera peticion. Esto evita que alguien sin sesion
 * llegue a ver el esqueleto del panel; la autorizacion real vive en el backend.
 */
export function middleware(request: NextRequest): NextResponse {
  const hasSession = Boolean(request.cookies.get("scire_rt")?.value);
  const { pathname } = request.nextUrl;

  const isProtected = pathname.startsWith("/dashboard") || pathname.startsWith("/admin");
  if (isProtected && !hasSession) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    // Se recuerda a donde iba para devolverlo alli tras entrar.
    url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }

  if (pathname === "/login" && hasSession) {
    const url = request.nextUrl.clone();
    url.pathname = "/dashboard";
    url.search = "";
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/dashboard/:path*", "/admin/:path*", "/login"],
};
