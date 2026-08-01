import { createFileRoute, Link, useNavigate, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { CheckCircle2, KeyRound, Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import {
  activateAccessSecret,
  getAccessGateStatus,
  requestAdminPasswordRecovery,
  submitAccessRequest,
} from "@/lib/access.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

export const Route = createFileRoute("/auth")({
  ssr: false,
  component: AuthPage,
});

type Gate = {
  approvalStatus: string;
  hasAccess: boolean;
};

function AuthPage() {
  const navigate = useNavigate();
  const router = useRouter();
  const getGate = useServerFn(getAccessGateStatus);
  const activate = useServerFn(activateAccessSecret);
  const submitWaitlist = useServerFn(submitAccessRequest);
  const requestPasswordRecovery = useServerFn(requestAdminPasswordRecovery);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [secret, setSecret] = useState("");
  const [gate, setGate] = useState<Gate | null>(null);
  const [needsPasswordSetup, setNeedsPasswordSetup] = useState(false);
  const [isPasswordRecovery, setIsPasswordRecovery] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [waitlistSent, setWaitlistSent] = useState(false);
  const [fullName, setFullName] = useState("");
  const [phone, setPhone] = useState("");
  const [waitlistEmail, setWaitlistEmail] = useState("");
  const [showPasswordRecovery, setShowPasswordRecovery] = useState(false);
  const [recoveryEmail, setRecoveryEmail] = useState("");
  const [recoverySent, setRecoverySent] = useState(false);

  async function refreshGate() {
    const status = await getGate({});
    setGate(status);
    if (status.hasAccess) {
      await router.invalidate();
      navigate({ to: "/dashboard", replace: true });
    }
  }

  useEffect(() => {
    let cancelled = false;
    const { data: authListener } = supabase.auth.onAuthStateChange((event) => {
      if (!cancelled && event === "PASSWORD_RECOVERY") setIsPasswordRecovery(true);
    });
    supabase.auth.getUser().then(async ({ data, error }) => {
      if (cancelled) return;
      if (error || !data.user) {
        await supabase.auth.signOut({ scope: "local" });
        if (!cancelled) setGate(null);
        return;
      }
      setNeedsPasswordSetup(data.user.user_metadata?.needs_password_setup === true);
      try {
        const status = await getGate({});
        if (!cancelled) {
          setGate(status);
          if (status.hasAccess && data.user.user_metadata?.needs_password_setup !== true) {
            navigate({ to: "/dashboard", replace: true });
          }
        }
      } catch {
        if (!cancelled) setGate(null);
      }
    });
    return () => {
      cancelled = true;
      authListener.subscription.unsubscribe();
    };
  }, [getGate, navigate]);

  async function handleSignIn(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    try {
      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      if (error || !data.user) throw new Error(error?.message ?? "Sign in failed.");
      setNeedsPasswordSetup(data.user.user_metadata?.needs_password_setup === true);
      await refreshGate();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Sign in failed.");
    } finally {
      setLoading(false);
    }
  }

  async function handlePasswordSetup(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    try {
      const { data: userData } = await supabase.auth.getUser();
      const metadata = userData.user?.user_metadata ?? {};
      const { error } = await supabase.auth.updateUser({
        password: newPassword,
        data: { ...metadata, needs_password_setup: false },
      });
      if (error) throw error;
      setNeedsPasswordSetup(false);
      setIsPasswordRecovery(false);
      toast.success("Password saved securely.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Password setup failed.");
    } finally {
      setLoading(false);
    }
  }

  async function handleActivation(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    try {
      await activate({ data: { secret } });
      await refreshGate();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Access verification failed.";
      if (message.includes("Unauthorized") || message.includes("Invalid token")) {
        await supabase.auth.signOut({ scope: "local" });
        setGate(null);
        toast.error("Your session expired. Sign in again to continue.");
      } else {
        toast.error(message);
      }
    } finally {
      setLoading(false);
    }
  }

  async function handleWaitlist(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    try {
      await submitWaitlist({ data: { fullName, phone, email: waitlistEmail } });
      setWaitlistSent(true);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Request submission failed.");
    } finally {
      setLoading(false);
    }
  }

  async function handlePasswordRecovery(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    try {
      await requestPasswordRecovery({ data: { email: recoveryEmail } });
      setRecoverySent(true);
    } catch {
      setRecoverySent(true);
    } finally {
      setLoading(false);
    }
  }

  if (gate) {
    return (
      <AuthFrame>
        <Card>
          <CardHeader>
            <CardTitle>
              {needsPasswordSetup || isPasswordRecovery ? "Create your password" : "Verify access"}
            </CardTitle>
            <CardDescription>
              {needsPasswordSetup || isPasswordRecovery
                ? isPasswordRecovery
                  ? "Choose a new password for your verified administrator account."
                  : "Finish securing your invited account before entering the workspace."
                : "Your account requires its administrator-issued access secret."}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {gate.approvalStatus !== "approved" ? (
              <StatusMessage status={gate.approvalStatus} />
            ) : needsPasswordSetup || isPasswordRecovery ? (
              <form className="space-y-4" onSubmit={handlePasswordSetup}>
                <div className="space-y-2">
                  <Label htmlFor="new-password">New password</Label>
                  <Input
                    id="new-password"
                    type="password"
                    minLength={8}
                    required
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                  />
                </div>
                <Button className="w-full" disabled={loading}>
                  {loading ? "Saving..." : "Save password"}
                </Button>
              </form>
            ) : (
              <>
                <form className="space-y-4" onSubmit={handleActivation}>
                  <div className="space-y-2">
                    <Label htmlFor="access-secret">Access secret</Label>
                    <Input
                      id="access-secret"
                      type="password"
                      autoComplete="off"
                      required
                      value={secret}
                      onChange={(e) => setSecret(e.target.value)}
                    />
                    <p className="text-xs text-muted-foreground">
                      A new browser profile uses one of five activations. Refreshes and additional
                      tabs do not.
                    </p>
                  </div>
                  <Button className="w-full" disabled={loading}>
                    <KeyRound className="mr-2 h-4 w-4" />
                    {loading ? "Verifying..." : "Enter workspace"}
                  </Button>
                </form>
              </>
            )}
            <Button
              variant="ghost"
              className="w-full"
              onClick={() => void supabase.auth.signOut().then(() => setGate(null))}
            >
              Sign out
            </Button>
          </CardContent>
        </Card>
      </AuthFrame>
    );
  }

  return (
    <AuthFrame>
      <Card>
        <CardHeader>
          <CardTitle>Welcome</CardTitle>
          <CardDescription>
            Approved members can sign in. New users can request access.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Tabs defaultValue="signin">
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="signin">Sign in</TabsTrigger>
              <TabsTrigger value="waitlist">Request access</TabsTrigger>
            </TabsList>
            <TabsContent value="signin">
              <form onSubmit={handleSignIn} className="mt-4 space-y-4">
                <Field label="Email" id="signin-email">
                  <Input
                    id="signin-email"
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                </Field>
                <Field label="Password" id="signin-password">
                  <Input
                    id="signin-password"
                    type="password"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </Field>
                <Button className="w-full" disabled={loading}>
                  {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : "Sign in"}
                </Button>
              </form>
              <Button
                type="button"
                variant="ghost"
                className="mt-2 w-full"
                onClick={() => setShowPasswordRecovery((current) => !current)}
              >
                Administrator password recovery
              </Button>
              {showPasswordRecovery ? (
                recoverySent ? (
                  <div className="mt-3 rounded-md border bg-muted/40 p-4 text-sm text-muted-foreground">
                    If this is an eligible administrator account, a password recovery email has been
                    sent. The link expires according to the authentication security policy.
                  </div>
                ) : (
                  <form className="mt-3 space-y-3" onSubmit={handlePasswordRecovery}>
                    <Field label="Administrator email" id="recovery-email">
                      <Input
                        id="recovery-email"
                        type="email"
                        autoComplete="email"
                        required
                        value={recoveryEmail}
                        onChange={(event) => setRecoveryEmail(event.target.value)}
                      />
                    </Field>
                    <Button type="submit" variant="outline" className="w-full" disabled={loading}>
                      {loading ? "Sending..." : "Send verification email"}
                    </Button>
                  </form>
                )
              ) : null}
            </TabsContent>
            <TabsContent value="waitlist">
              {waitlistSent ? (
                <div className="mt-6 text-center">
                  <CheckCircle2 className="mx-auto h-8 w-8 text-primary" />
                  <p className="mt-3 font-medium">Request received</p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    We will contact you after an administrator reviews your application.
                  </p>
                </div>
              ) : (
                <form onSubmit={handleWaitlist} className="mt-4 space-y-4">
                  <Field label="Full name" id="full-name">
                    <Input
                      id="full-name"
                      required
                      minLength={2}
                      value={fullName}
                      onChange={(e) => setFullName(e.target.value)}
                    />
                  </Field>
                  <Field label="Phone with country code" id="phone">
                    <Input
                      id="phone"
                      type="tel"
                      placeholder="+1 555 123 4567"
                      required
                      value={phone}
                      onChange={(e) => setPhone(e.target.value)}
                    />
                  </Field>
                  <Field label="Email" id="waitlist-email">
                    <Input
                      id="waitlist-email"
                      type="email"
                      required
                      value={waitlistEmail}
                      onChange={(e) => setWaitlistEmail(e.target.value)}
                    />
                  </Field>
                  <Button className="w-full" disabled={loading}>
                    {loading ? "Submitting..." : "Yes, I want to save time"}
                  </Button>
                  <Button type="button" variant="ghost" className="w-full" asChild>
                    <Link to="/">No, I'll keep spending two hours per video</Link>
                  </Button>
                </form>
              )}
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
    </AuthFrame>
  );
}

function AuthFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 py-12">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <Link to="/" className="text-2xl font-bold">
            Auto Video Creator
          </Link>
          <p className="mt-2 text-sm text-muted-foreground">Approval-only creative workspace</p>
        </div>
        {children}
      </div>
    </div>
  );
}

function Field({ label, id, children }: { label: string; id: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      {children}
    </div>
  );
}

function StatusMessage({ status }: { status: string }) {
  const text =
    status === "rejected"
      ? "This access request was not approved."
      : status === "suspended"
        ? "This account is suspended. Contact support."
        : "This account is waiting for administrator approval.";
  return <div className="rounded-md border bg-muted/40 p-4 text-sm">{text}</div>;
}
