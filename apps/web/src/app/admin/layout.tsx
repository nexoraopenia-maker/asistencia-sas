import { redirect } from "next/navigation";
import { AdminTopbar } from "../../components/admin-topbar";
import { getSessionProfile } from "../../lib/session";

/**
 * Consola de plataforma: solo SUPER_ADMIN.
 *
 * La comprobacion de rol aqui es de experiencia de usuario (la cookie de
 * perfil no esta firmada). La autorizacion real la aplica la API en
 * `/api/v1/platform`, que exige SUPER_ADMIN sobre el rol vigente en base.
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const profile = await getSessionProfile();
  if (!profile) redirect("/login");
  if (profile.role !== "SUPER_ADMIN") redirect("/dashboard");

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <AdminTopbar profile={profile} />
      <main className="min-w-0 flex-1">{children}</main>
    </div>
  );
}
