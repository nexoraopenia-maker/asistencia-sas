import { PageHeader } from "../../components/page-header";
import { PunchFeed } from "../../components/punch-feed";
import { LiveStats } from "../../components/live-stats";

export const metadata = { title: "Feed en vivo" };

export default function DashboardPage() {
  return (
    <>
      <PageHeader
        title="Feed en vivo"
        description="Marcaciones en tiempo real con verificacion de selfie y geocerca"
      />
      <div className="space-y-6 p-6">
        <LiveStats />
        <PunchFeed />
      </div>
    </>
  );
}
