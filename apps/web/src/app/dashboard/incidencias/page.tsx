import { IncidentsView } from "../../../components/incidents-view";
import { PageHeader } from "../../../components/page-header";

export const metadata = { title: "Incidencias" };

export default function IncidenciasPage() {
  return (
    <>
      <PageHeader
        title="Incidencias y cumplimiento"
        description="Salidas faltantes, faltas, tardanzas y justificaciones del periodo"
      />
      <div className="p-6">
        <IncidentsView />
      </div>
    </>
  );
}
