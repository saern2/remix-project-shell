import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/_authenticated")({
  ssr: false,
  beforeLoad: async () => {
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) throw redirect({ to: "/auth" });

    const { data: profile, error: profileError } = await supabase
      .from("users")
      .select("approval_status")
      .eq("id", data.user.id)
      .maybeSingle();
    if (profileError) throw profileError;

    const approvalStatus = profile?.approval_status;
    if (approvalStatus !== "approved") {
      await supabase.auth.signOut();
      throw redirect({
        to: "/auth",
        search: {
          approval: approvalStatus === "rejected" ? "rejected" : "pending",
        },
      });
    }

    return { user: data.user, profile };
  },
  component: () => <Outlet />,
});
