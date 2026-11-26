import { PageHeader } from "../../../components/page-header";
import { ReportsView } from "../../../components/reports-view";

export const metadata = { title: "Reportes de nomina" };

export default function ReportesPage() {
  return (
    <>
      <PageHeader
        title="Reportes de nomina"
        description="KPIs de asistencia y exportacion en Excel y PDF"
      />
      <div className="p-6">
        <ReportsView />
      </div>
    </>
  );
}
