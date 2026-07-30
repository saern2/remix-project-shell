import { createFileRoute, useNavigate, useRouter, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { toast } from "sonner";

type ApprovalSearch = {
  approval?: "pending" | "rejected";
};

type ApprovalStatus = "pending" | "approved" | "rejected";

export const Route = createFileRoute("/auth")({
  ssr: false,
  validateSearch: (search: Record<string, unknown>): ApprovalSearch => {
    const approval = search.approval;
    return {
      approval: approval === "pending" || approval === "rejected" ? approval : undefined,
    };
  },
  component: AuthPage,
});

async function getApprovalStatus(userId: string): Promise<ApprovalStatus> {
  const { data, error } = await supabase
    .from("users")
    .select("approval_status")
    .eq("id", userId)
    .maybeSingle();
  if (error) throw error;
  return data?.approval_status === "approved" || data?.approval_status === "rejected"
    ? data.approval_status
    : "pending";
}

function approvalMessage(status?: ApprovalSearch["approval"]) {
  if (status === "rejected") {
    return "This account has not been approved for access. Contact the platform admin if you believe this is a mistake.";
  }
  if (status === "pending") {
    return "Your account is waiting for admin approval. You can sign in after an admin approves it.";
  }
  return null;
}

function AuthPage() {
  const navigate = useNavigate();
  const router = useRouter();
  const search = Route.useSearch();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const gateMessage = approvalMessage(search.approval);

  useEffect(() => {
    let cancelled = false;
    supabase.auth.getUser().then(async ({ data }) => {
      if (!data.user) return;
      try {
        const approvalStatus = await getApprovalStatus(data.user.id);
        if (cancelled) return;
        if (approvalStatus === "approved") {
          navigate({ to: "/dashboard", replace: true });
        } else {
          await supabase.auth.signOut();
        }
      } catch (err) {
        if (!cancelled) toast.error((err as Error).message);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [navigate]);

  const handleSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) {
        toast.error(error.message);
        return;
      }
      if (!data.user) {
        toast.error("Sign in did not return a user session.");
        return;
      }
      const approvalStatus = await getApprovalStatus(data.user.id);
      if (approvalStatus !== "approved") {
        await supabase.auth.signOut();
        toast.info(
          approvalStatus === "rejected"
            ? "This account has not been approved for access."
            : "Your account is waiting for admin approval.",
        );
        return;
      }
      await router.invalidate();
      navigate({ to: "/dashboard", replace: true });
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const handleSignUp = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: { emailRedirectTo: window.location.origin },
    });
    setLoading(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success(
      "Check your email to confirm your account. An admin must approve it before you can sign in.",
    );
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 py-12">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <Link to="/" className="text-2xl font-bold tracking-tight">
            Auto Video Creator
          </Link>
          <p className="mt-2 text-sm text-muted-foreground">Turn audio into scene-matched video.</p>
        </div>
        <Card>
          <CardHeader>
            <CardTitle>Welcome</CardTitle>
            <CardDescription>Sign in or create an account to get started.</CardDescription>
          </CardHeader>
          <CardContent>
            {gateMessage ? (
              <div className="mb-4 rounded-lg border border-primary/30 bg-primary/10 px-3 py-2 text-sm text-foreground">
                {gateMessage}
              </div>
            ) : null}
            <Tabs defaultValue="signin">
              <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="signin">Sign in</TabsTrigger>
                <TabsTrigger value="signup">Sign up</TabsTrigger>
              </TabsList>
              <TabsContent value="signin">
                <form onSubmit={handleSignIn} className="mt-4 space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="signin-email">Email</Label>
                    <Input
                      id="signin-email"
                      type="email"
                      required
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="signin-password">Password</Label>
                    <Input
                      id="signin-password"
                      type="password"
                      required
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                    />
                  </div>
                  <Button type="submit" className="w-full" disabled={loading}>
                    {loading ? "Signing in..." : "Sign in"}
                  </Button>
                </form>
              </TabsContent>
              <TabsContent value="signup">
                <form onSubmit={handleSignUp} className="mt-4 space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="signup-email">Email</Label>
                    <Input
                      id="signup-email"
                      type="email"
                      required
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="signup-password">Password</Label>
                    <Input
                      id="signup-password"
                      type="password"
                      required
                      minLength={6}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                    />
                  </div>
                  <Button type="submit" className="w-full" disabled={loading}>
                    {loading ? "Creating account..." : "Create account"}
                  </Button>
                </form>
              </TabsContent>
            </Tabs>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
