import { createFileRoute } from "@tanstack/react-router";
import { StatsDashboard } from "@/components/stats-dashboard";

export const Route = createFileRoute("/_authenticated/stats")({
  component: () => <StatsDashboard />,
});
