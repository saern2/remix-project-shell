import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect } from "react";
import { ArrowLeft } from "lucide-react";
import { amIAdmin } from "@/lib/admin.functions";
import { AdminUsersPanel } from "@/routes/_authenticated/admin";
import { AdminAccessPanel } from "@/components/admin-access-panel";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

export const Route = createFileRoute("/_authenticated/users")({
  head: () => ({
    meta: [
      { title: "User management - Auto Video Creator" },
      { name: "description", content: "Manage user accounts, approvals, and access secrets." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: AdminUsersPage,
});

function AdminUsersPage() {
  const navigate = useNavigate();
  const check = useServerFn(amIAdmin);
  const { data, isPending } = useQuery({
    queryKey: ["am-i-admin"],
    queryFn: () => check({}),
    retry: false,
  });

  useEffect(() => {
    if (!isPending && data && !data.isAdmin) {
      navigate({ to: "/dashboard", replace: true });
    }
  }, [data, isPending, navigate]);

  if (isPending) {
    return (
      <div className="mx-auto max-w-6xl space-y-4 p-6">
        <Skeleton className="h-10 w-48" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (!data?.isAdmin) return null;

  return (
    <div className="mx-auto max-w-7xl space-y-6 p-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Users</h1>
          <p className="text-sm text-muted-foreground">
            Accounts, approvals, invitations, and user access secrets
          </p>
        </div>
        <Button variant="outline" asChild>
          <Link to="/admin">
            <ArrowLeft className="mr-2 h-4 w-4" /> Admin overview
          </Link>
        </Button>
      </div>

      <Tabs defaultValue="accounts">
        <TabsList>
          <TabsTrigger value="accounts">Accounts</TabsTrigger>
          <TabsTrigger value="access">Requests and secrets</TabsTrigger>
        </TabsList>
        <TabsContent value="accounts" className="mt-4">
          <AdminUsersPanel />
        </TabsContent>
        <TabsContent value="access" className="mt-4">
          <AdminAccessPanel />
        </TabsContent>
      </Tabs>
    </div>
  );
}
