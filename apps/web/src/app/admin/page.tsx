import { PageHeader } from "../../components/page-header";
import { TenantsAdmin } from "../../components/tenants-admin";
import { getSessionProfile } from "../../lib/session";

export const metadata = { title: "Empresas" };

export default async function AdminPage() {
  const profile = await getSessionProfile();

  return (
    <>
      <PageHeader
        title="Empresas"
        description="Alta de clientes, plan contratado y suspension manual de cuentas"
      />
      <div className="p-6">
        <TenantsAdmin ownCompanyId={profile?.companyId ?? ""} />
      </div>
    </>
  );
}
