import { EmployeesTable } from "../../../components/employees-table";
import { PageHeader } from "../../../components/page-header";

export const metadata = { title: "Empleados" };

export default function EmpleadosPage() {
  return (
    <>
      <PageHeader
        title="Empleados"
        description="Alta, invitaciones y estado de los colaboradores"
      />
      <div className="p-6">
        <EmployeesTable />
      </div>
    </>
  );
}
