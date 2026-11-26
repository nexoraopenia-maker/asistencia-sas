import { CompanySettings } from "../../../components/company-settings";
import { PageHeader } from "../../../components/page-header";

export const metadata = { title: "Configuracion" };

export default function ConfiguracionPage() {
  return (
    <>
      <PageHeader
        title="Configuracion"
        description="Reglas de marcacion, sucursales y geocercas"
      />
      <div className="p-6">
        <CompanySettings />
      </div>
    </>
  );
}
