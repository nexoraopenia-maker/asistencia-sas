import { NextResponse, type NextRequest } from "next/server";
import { UserRole, roleAtLeast } from "@scire/shared";
import { API_URL, setProfileCookie, setSessionCookies } from "../../../../lib/session";

export const runtime = "nodejs";

/**
 * Login del dashboard.
 *
 * Ademas de autenticar, comprueba el ROL: el panel de RRHH es para
 * `HR_ADMIN` y `SUPER_ADMIN`. Un empleado con credenciales validas entra en la
 * app movil, no aqui. La comprobacion se hace en el servidor, no ocultando
 * botones en la interfaz.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const { email, password } = await request.json();

  const response = await fetch(`${API_URL}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email,
      password,
      deviceId: "scire-web-dashboard",
      deviceName: "Panel web de RRHH",
    }),
    cache: "no-store",
  });

  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    return NextResponse.json(payload ?? { success: false }, { status: response.status });
  }

  const { user, tokens } = payload.data;

  if (!roleAtLeast(user.role as UserRole, UserRole.HR_ADMIN)) {
    return NextResponse.json(
      {
        success: false,
        error: {
          code: "FORBIDDEN",
          message:
            "Este panel es para Recursos Humanos. Usa la aplicacion movil para marcar tu asistencia.",
        },
      },
      { status: 403 },
    );
  }

  await setSessionCookies(tokens);
  await setProfileCookie({
    id: user.id,
    fullName: user.fullName,
    email: user.email,
    role: user.role,
    companyId: user.companyId,
    companyName: user.companyName,
    employeeCode: user.employeeCode,
    jobTitle: user.jobTitle,
    branchId: user.branchId,
  });

  return NextResponse.json({ success: true, data: { user } });
}
