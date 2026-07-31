import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { LogOut, Mail } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/_authenticated/account")({ component: AccountPage });

function AccountPage() {
  const { user } = Route.useRouteContext();
  const navigate = useNavigate();
  const signOut = async () => {
    await supabase.auth.signOut();
    navigate({ to: "/auth", replace: true });
  };
  return (
    <main className="mx-auto max-w-5xl px-5 py-8 sm:px-8 lg:py-10">
      <div className="mb-8">
        <p className="text-sm font-medium text-primary">Profile</p>
        <h1 className="mt-1 text-2xl font-semibold">Account</h1>
        <p className="mt-2 text-sm text-muted-foreground">Your signed-in account information.</p>
      </div>
      <section className="border-t py-6">
        <div className="flex items-center gap-3">
          <span className="grid h-10 w-10 place-items-center rounded-md bg-muted">
            <Mail className="h-4 w-4" />
          </span>
          <div>
            <p className="text-xs text-muted-foreground">Email</p>
            <p className="text-sm font-medium">{user.email ?? "Not available"}</p>
          </div>
        </div>
        <Button variant="outline" className="mt-6" onClick={() => void signOut()}>
          <LogOut className="mr-2 h-4 w-4" />
          Sign out
        </Button>
      </section>
    </main>
  );
}
