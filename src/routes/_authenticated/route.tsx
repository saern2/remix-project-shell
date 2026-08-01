import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { AppShell } from "@/components/app-shell";
import { getAccessGateStatus } from "@/lib/access.functions";

export const Route = createFileRoute("/_authenticated")({
  ssr: false,
  beforeLoad: async () => {
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) throw redirect({ to: "/auth" });

    let gate: Awaited<ReturnType<typeof getAccessGateStatus>>;
    try {
      gate = await getAccessGateStatus();
    } catch {
      // Not approved / no verified client yet — send them to the gate screen.
      throw redirect({ to: "/auth" });
    }
    if (!gate.hasAccess) throw redirect({ to: "/auth" });

    return { user: data.user, profile: gate };
  },
  component: AuthenticatedLayout,
});

function AuthenticatedLayout() {
  const { user } = Route.useRouteContext();
  return (
    <AppShell email={user.email}>
      <Outlet />
    </AppShell>
  );
}
