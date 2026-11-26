import { PageHeader } from "../../../components/page-header";
import { SubscriptionPanel } from "../../../components/subscription-panel";

export const metadata = { title: "Suscripcion" };

export default function SuscripcionPage() {
  return (
    <>
      <PageHeader
        title="Suscripcion"
        description="Plan contratado, consumo de asientos e historial de facturas"
      />
      <div className="p-6">
        <SubscriptionPanel />
      </div>
    </>
  );
}
