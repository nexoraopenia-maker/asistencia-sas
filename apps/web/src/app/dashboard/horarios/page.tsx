import { PageHeader } from "../../../components/page-header";
import { ShiftMatrix } from "../../../components/shift-matrix";

export const metadata = { title: "Horarios y turnos" };

export default function HorariosPage() {
  return (
    <>
      <PageHeader
        title="Horarios y turnos"
        description="Matriz semanal, asignacion masiva y reglas de tolerancia"
      />
      <div className="p-6">
        <ShiftMatrix />
      </div>
    </>
  );
}
