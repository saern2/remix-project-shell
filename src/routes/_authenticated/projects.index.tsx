import { createFileRoute } from "@tanstack/react-router";
import { ProjectOverview } from "@/components/project-overview";

export const Route = createFileRoute("/_authenticated/projects/")({
  component: () => <ProjectOverview projectsOnly />,
});
