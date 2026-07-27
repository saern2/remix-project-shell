import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";
import {
  amIAdmin,
  getAdminOverview,
  listAdminUsers,
  listPexelsKeys,
  previewPexelsKeys,
  setUserApprovalStatus,
  setUserPlanTier,
  setUserRole,
  uploadPexelsKeys,
  deactivatePexelsKey,
} from "@/lib/admin.functions";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { toast } from "sonner";
import { ArrowLeft, Loader2, Upload, ShieldCheck } from "lucide-react";

export const Route = createFileRoute("/_authenticated/admin")({
  head: () => ({
    meta: [
      { title: "Admin panel — Auto Video Creator" },
      { name: "description", content: "Manage users, renders, and the Pexels key pool." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: AdminPage,
});

function AdminPage() {
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
  }, [isPending, data, navigate]);

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
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Admin panel</h1>
          <p className="text-sm text-muted-foreground">Users, renders and Pexels key pool</p>
        </div>
        <Button variant="outline" asChild>
          <Link to="/dashboard">
            <ArrowLeft className="mr-2 h-4 w-4" /> Back
          </Link>
        </Button>
      </div>

      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="users">Users</TabsTrigger>
          <TabsTrigger value="keys">Pexels keys</TabsTrigger>
        </TabsList>
        <TabsContent value="overview" className="mt-4">
          <OverviewTab />
        </TabsContent>
        <TabsContent value="users" className="mt-4">
          <UsersTab />
        </TabsContent>
        <TabsContent value="keys" className="mt-4">
          <KeysTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardDescription>{label}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-semibold">{value}</div>
      </CardContent>
    </Card>
  );
}

function OverviewTab() {
  const fetchOverview = useServerFn(getAdminOverview);
  const { data, isPending, error } = useQuery({
    queryKey: ["admin-overview"],
    queryFn: () => fetchOverview({}),
  });

  if (isPending) return <Skeleton className="h-64 w-full" />;
  if (error) return <p className="text-sm text-destructive">{(error as Error).message}</p>;

  const max = Math.max(1, ...data.rendersPerDay.map((d) => d.count));

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Total users" value={data.totalUsers} />
        <Stat label="Pending" value={data.usersByStatus.pending ?? 0} />
        <Stat label="Approved" value={data.usersByStatus.approved ?? 0} />
        <Stat label="Rejected" value={data.usersByStatus.rejected ?? 0} />
        <Stat label="Completed renders" value={data.totalCompletedRenders} />
        <Stat label="Pexels keys" value={data.keyPool.total} />
        <Stat label="Active keys" value={data.keyPool.active} />
        <Stat label="Keys with errors" value={data.keyPool.withError} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Renders per day (last 30 days)</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex h-40 items-end gap-1">
            {data.rendersPerDay.map((d) => (
              <div key={d.date} className="flex flex-1 flex-col items-center gap-1" title={`${d.date}: ${d.count}`}>
                <div
                  className="w-full rounded-sm bg-primary"
                  style={{ height: `${(d.count / max) * 100}%`, minHeight: d.count > 0 ? 4 : 1 }}
                />
              </div>
            ))}
          </div>
          <div className="mt-2 flex justify-between text-xs text-muted-foreground">
            <span>{data.rendersPerDay[0]?.date}</span>
            <span>{data.rendersPerDay[data.rendersPerDay.length - 1]?.date}</span>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Top 10 users by renders</CardTitle>
          </CardHeader>
          <CardContent>
            {data.topUsers.length === 0 ? (
              <p className="text-sm text-muted-foreground">No completed renders yet.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Email</TableHead>
                    <TableHead className="text-right">Renders</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.topUsers.map((u) => (
                    <TableRow key={u.userId}>
                      <TableCell>{u.email}</TableCell>
                      <TableCell className="text-right">{u.count}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Most recent key errors</CardTitle>
          </CardHeader>
          <CardContent>
            {data.keyPool.recentErrors.length === 0 ? (
              <p className="text-sm text-muted-foreground">No key errors recorded.</p>
            ) : (
              <ul className="space-y-2 text-sm">
                {data.keyPool.recentErrors.map((k) => (
                  <li key={k.id} className="flex justify-between gap-4">
                    <span className="font-mono">{k.masked}</span>
                    <span className="text-muted-foreground">{k.last_error}</span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function UsersTab() {
  const qc = useQueryClient();
  const fetchUsers = useServerFn(listAdminUsers);
  const approvalFn = useServerFn(setUserApprovalStatus);
  const planFn = useServerFn(setUserPlanTier);
  const roleFn = useServerFn(setUserRole);
  const [filter, setFilter] = useState<string>("all");
  const [busy, setBusy] = useState<string | null>(null);

  // Get the currently logged-in user's ID for the self-action guard.
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => setCurrentUserId(data.user?.id ?? null));
  }, []);

  const { data, isPending, error } = useQuery({
    queryKey: ["admin-users"],
    queryFn: () => fetchUsers({}),
  });

  async function run(id: string, fn: () => Promise<unknown>, message: string) {
    setBusy(id);
    try {
      await fn();
      await qc.invalidateQueries({ queryKey: ["admin-users"] });
      await qc.invalidateQueries({ queryKey: ["admin-overview"] });
      toast.success(message);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Action failed");
    } finally {
      setBusy(null);
    }
  }

  if (isPending) return <Skeleton className="h-64 w-full" />;
  if (error) return <p className="text-sm text-destructive">{(error as Error).message}</p>;

  const rows = data.filter((u) => filter === "all" || u.approval_status === filter);

  return (
    <TooltipProvider delayDuration={200}>
      <Card>
        <CardHeader className="flex-row items-center justify-between gap-4 space-y-0">
          <CardTitle className="text-base">Users</CardTitle>
          <Select value={filter} onValueChange={setFilter}>
            <SelectTrigger className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              <SelectItem value="pending">Pending</SelectItem>
              <SelectItem value="approved">Approved</SelectItem>
              <SelectItem value="rejected">Rejected</SelectItem>
            </SelectContent>
          </Select>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Email</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Approval</TableHead>
                <TableHead>Plan</TableHead>
                <TableHead>Joined</TableHead>
                <TableHead className="text-right">Renders</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((u) => {
                // Determine why destructive actions are blocked for this row.
                const isPrimaryAdmin = !!u.is_primary_admin;
                const isSelf = u.id === currentUserId;
                const rejectBlockReason = isPrimaryAdmin
                  ? "Protected: primary admin account cannot be modified"
                  : isSelf
                    ? "You cannot reject your own account"
                    : null;
                const removeAdminBlockReason = isPrimaryAdmin
                  ? "Protected: primary admin account cannot be modified"
                  : isSelf
                    ? "You cannot remove your own admin role"
                    : null;

                return (
                  <TableRow key={u.id}>
                    <TableCell className="font-medium">
                      <span className="flex items-center gap-1.5">
                        {u.email}
                        {isPrimaryAdmin && (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-amber-500" />
                            </TooltipTrigger>
                            <TooltipContent>Primary admin — protected account</TooltipContent>
                          </Tooltip>
                        )}
                      </span>
                    </TableCell>
                    <TableCell>
                      <Badge variant={u.role === "admin" ? "default" : "outline"}>{u.role}</Badge>
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={
                          u.approval_status === "approved"
                            ? "default"
                            : u.approval_status === "rejected"
                              ? "destructive"
                              : "secondary"
                        }
                      >
                        {u.approval_status}
                      </Badge>
                    </TableCell>
                    <TableCell>{u.plan_tier}</TableCell>
                    <TableCell>{new Date(u.created_at).toLocaleDateString()}</TableCell>
                    <TableCell className="text-right">{u.renderCount}</TableCell>
                    <TableCell>
                      <div className="flex flex-wrap justify-end gap-2">
                        {busy === u.id && <Loader2 className="h-4 w-4 animate-spin" />}
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy === u.id || u.approval_status === "approved"}
                          onClick={() =>
                            run(
                              u.id,
                              () => approvalFn({ data: { userId: u.id, approvalStatus: "approved" } }),
                              "User approved",
                            )
                          }
                        >
                          Approve
                        </Button>

                        {/* Reject — disabled with tooltip when protected */}
                        {rejectBlockReason ? (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span>
                                <Button size="sm" variant="outline" disabled>
                                  Reject
                                </Button>
                              </span>
                            </TooltipTrigger>
                            <TooltipContent>{rejectBlockReason}</TooltipContent>
                          </Tooltip>
                        ) : (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={busy === u.id || u.approval_status === "rejected"}
                            onClick={() =>
                              run(
                                u.id,
                                () => approvalFn({ data: { userId: u.id, approvalStatus: "rejected" } }),
                                "User rejected",
                              )
                            }
                          >
                            Reject
                          </Button>
                        )}

                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy === u.id || u.plan_tier === "free"}
                          onClick={() =>
                            run(
                              u.id,
                              () => planFn({ data: { userId: u.id, planTier: "free" } }),
                              "Downgraded to free",
                            )
                          }
                        >
                          Downgrade to free
                        </Button>

                        {/* Remove admin — disabled with tooltip when protected */}
                        {u.role === "admin" && removeAdminBlockReason ? (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span>
                                <Button size="sm" variant="secondary" disabled>
                                  Remove admin
                                </Button>
                              </span>
                            </TooltipTrigger>
                            <TooltipContent>{removeAdminBlockReason}</TooltipContent>
                          </Tooltip>
                        ) : (
                          <Button
                            size="sm"
                            variant="secondary"
                            disabled={busy === u.id}
                            onClick={() =>
                              run(
                                u.id,
                                () =>
                                  roleFn({
                                    data: { userId: u.id, role: u.role === "admin" ? "user" : "admin" },
                                  }),
                                u.role === "admin" ? "Admin removed" : "Admin granted",
                              )
                            }
                          >
                            {u.role === "admin" ? "Remove admin" : "Make admin"}
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </TooltipProvider>
  );
}

function KeysTab() {
  const qc = useQueryClient();
  const fetchKeys = useServerFn(listPexelsKeys);
  const preview = useServerFn(previewPexelsKeys);
  const upload = useServerFn(uploadPexelsKeys);
  const deactivate = useServerFn(deactivatePexelsKey);

  // Phase 1: preview state
  const [pendingCsv, setPendingCsv] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewResult, setPreviewResult] = useState<Awaited<ReturnType<typeof preview>> | null>(null);
  const [safetyThreshold, setSafetyThreshold] = useState(5);

  // Phase 2: upload state
  const [uploading, setUploading] = useState(false);
  const [report, setReport] = useState<Awaited<ReturnType<typeof upload>> | null>(null);

  const { data, isPending, error } = useQuery({
    queryKey: ["admin-pexels-keys"],
    queryFn: () => fetchKeys({}),
  });

  async function handleFile(file: File) {
    setPreviewing(true);
    setPreviewResult(null);
    setReport(null);
    try {
      const csv = await file.text();
      setPendingCsv(csv);
      const res = await preview({ data: { csv } });
      setPreviewResult(res);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Preview failed");
      setPendingCsv(null);
    } finally {
      setPreviewing(false);
    }
  }

  async function handleCommit() {
    if (!pendingCsv) return;
    setUploading(true);
    setReport(null);
    try {
      const res = await upload({ data: { csv: pendingCsv, safetyThreshold } });
      setReport(res);
      setPreviewResult(null);
      setPendingCsv(null);
      await qc.invalidateQueries({ queryKey: ["admin-pexels-keys"] });
      await qc.invalidateQueries({ queryKey: ["admin-overview"] });
      if (res.committed) {
        toast.success(`${res.inserted} keys added, old pool deactivated`);
      } else {
        toast.warning(res.warning ?? "Upload did not meet safety threshold");
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Upload keys (CSV)</CardTitle>
          <CardDescription>
            Accepts newline-separated, comma-separated, or mixed format. Each key is tested
            against the live Pexels API. Old active keys are only deactivated if the new batch
            meets the safety threshold.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-4">
            <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm">
              {previewing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
              {previewing ? "Parsing…" : "Choose CSV file"}
              <input
                type="file"
                accept=".csv,text/csv,text/plain"
                className="hidden"
                disabled={previewing || uploading}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = "";
                  if (f) void handleFile(f);
                }}
              />
            </label>
            <div className="flex items-center gap-2 text-sm">
              <label htmlFor="threshold" className="text-muted-foreground whitespace-nowrap">
                Safety threshold (min valid keys before replacing pool):
              </label>
              <input
                id="threshold"
                type="number"
                min={1}
                max={100}
                value={safetyThreshold}
                onChange={(e) => setSafetyThreshold(Math.max(1, parseInt(e.target.value) || 1))}
                className="w-16 rounded-md border px-2 py-1 text-sm"
                disabled={uploading}
              />
            </div>
          </div>

          {/* Phase 1: Parse preview — admin confirms before committing */}
          {previewResult && !report && (
            <div className="space-y-3 rounded-md border p-4">
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium">
                  Parsed {previewResult.parsedCount} key{previewResult.parsedCount !== 1 ? "s" : ""}
                  {previewResult.duplicateCount > 0 && (
                    <span className="ml-2 text-muted-foreground">
                      ({previewResult.duplicateCount} already in pool — will be skipped)
                    </span>
                  )}
                </p>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => { setPreviewResult(null); setPendingCsv(null); }}
                    disabled={uploading}
                  >
                    Cancel
                  </Button>
                  <Button size="sm" onClick={handleCommit} disabled={uploading}>
                    {uploading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                    Validate &amp; upload (threshold: {safetyThreshold})
                  </Button>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                If ≥ {safetyThreshold} key{safetyThreshold !== 1 ? "s" : ""} pass Pexels validation,
                all currently-active keys will be deactivated and the new ones activated.
                If fewer pass, the old pool stays untouched.
              </p>
              <div className="max-h-48 overflow-y-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>#</TableHead>
                      <TableHead>Key (masked)</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {previewResult.preview.map((p) => (
                      <TableRow key={p.index}>
                        <TableCell>{p.index}</TableCell>
                        <TableCell className="font-mono">{p.masked}</TableCell>
                        <TableCell>
                          {p.isDuplicate
                            ? <Badge variant="secondary">duplicate</Badge>
                            : <Badge variant="default">new</Badge>}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          )}

          {/* Phase 2: Upload result */}
          {report && (
            <div className="space-y-3 rounded-md border p-4">
              {report.committed ? (
                <div className="flex items-center gap-2 text-sm font-medium text-green-600">
                  ✓ Pool replaced: {report.inserted} keys activated, old keys deactivated
                </div>
              ) : (
                <div className="rounded-md bg-amber-50 p-3 text-sm text-amber-800 border border-amber-200">
                  ⚠ {report.warning}
                </div>
              )}
              <div className="flex gap-4 text-sm text-muted-foreground">
                <span>Valid: {report.validCount}</span>
                <span>Invalid: {report.invalid}</span>
                <span>Duplicates: {report.duplicates}</span>
                {report.errors > 0 && <span className="text-destructive">Errors: {report.errors}</span>}
              </div>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Key</TableHead>
                    <TableHead>Result</TableHead>
                    <TableHead>Detail</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {report.results.map((r, i) => (
                    <TableRow key={i}>
                      <TableCell className="font-mono">{r.masked}</TableCell>
                      <TableCell>
                        <Badge variant={
                          r.status === "inserted" ? "default"
                          : r.status === "valid" ? "default"
                          : r.status === "duplicate" ? "secondary"
                          : "destructive"
                        }>
                          {r.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-muted-foreground">{r.detail ?? "—"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Key pool</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {isPending ? (
            <Skeleton className="h-40 w-full" />
          ) : error ? (
            <p className="text-sm text-destructive">{(error as Error).message}</p>
          ) : data.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Pool is empty — stock search is using the environment keys.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Key</TableHead>
                  <TableHead>Active</TableHead>
                  <TableHead className="text-right">Requests</TableHead>
                  <TableHead>Last used</TableHead>
                  <TableHead>Last error</TableHead>
                  <TableHead>Errored at</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.map((k) => (
                  <TableRow key={k.id}>
                    <TableCell className="font-mono">{k.api_key}</TableCell>
                    <TableCell>
                      <Badge variant={k.is_active ? "default" : "destructive"}>
                        {k.is_active ? "active" : "inactive"}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">{k.request_count}</TableCell>
                    <TableCell>{k.last_used_at ? new Date(k.last_used_at).toLocaleString() : "—"}</TableCell>
                    <TableCell className="text-muted-foreground">{k.last_error ?? "—"}</TableCell>
                    <TableCell>{k.last_error_at ? new Date(k.last_error_at).toLocaleString() : "—"}</TableCell>
                    <TableCell className="text-right">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!k.is_active}
                        onClick={async () => {
                          try {
                            await deactivate({ data: { id: k.id } });
                            await qc.invalidateQueries({ queryKey: ["admin-pexels-keys"] });
                            toast.success("Key deactivated");
                          } catch (e) {
                            toast.error(e instanceof Error ? e.message : "Failed");
                          }
                        }}
                      >
                        Deactivate
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
