import { redirect } from "next/navigation";
import { AccountBanner } from "../../components/account-banner";
import { BranchProvider } from "../../components/branch-context";
import { OfflineBanner } from "../../components/offline-banner";
import { Sidebar } from "../../components/sidebar";
import { getSessionProfile } from "../../lib/session";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const profile = await getSessionProfile();
  // El middleware ya bloquea sin cookie de sesion; esto cubre el caso de una
  // cookie de perfil corrupta o borrada a mano.
  if (!profile) redirect("/login");

  return (
    <BranchProvider>
      {/* En movil la navegacion es una barra superior y el contenido va
          debajo; a partir de lg el sidebar pasa a la izquierda. */}
      <div className="flex min-h-screen flex-col lg:flex-row">
        <Sidebar profile={profile} />
        <main className="min-w-0 flex-1 bg-background">
          <OfflineBanner />
          <AccountBanner />
          {children}
        </main>
      </div>
    </BranchProvider>
  );
}
