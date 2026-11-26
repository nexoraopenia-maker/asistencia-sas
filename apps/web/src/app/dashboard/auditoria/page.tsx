import { AuditViewer } from "../../../components/audit-viewer";
import { PageHeader } from "../../../components/page-header";

export const metadata = { title: "Auditoria laboral" };

export default function AuditoriaPage() {
  return (
    <>
      <PageHeader
        title="Auditoria laboral"
        description="Registro inmutable de toda modificacion sobre datos de asistencia"
      />
      <div className="p-6">
        <AuditViewer />
      </div>
    </>
  );
}
