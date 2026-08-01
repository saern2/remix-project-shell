import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { KeyRound, Loader2, ShieldX } from "lucide-react";
import { toast } from "sonner";
import {
  issueUserAccessSecret,
  listAccessAdministration,
  reviewAccessRequest,
  revokeUserAccessSecret,
} from "@/lib/access.functions";
import { listAdminUsers } from "@/lib/admin.functions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export function AdminAccessPanel() {
  const qc = useQueryClient();
  const fetchAccess = useServerFn(listAccessAdministration);
  const fetchUsers = useServerFn(listAdminUsers);
  const review = useServerFn(reviewAccessRequest);
  const issue = useServerFn(issueUserAccessSecret);
  const revoke = useServerFn(revokeUserAccessSecret);
  const [busy, setBusy] = useState<string | null>(null);
  const [revealedSecret, setRevealedSecret] = useState<{ email: string; secret: string } | null>(
    null,
  );
  const access = useQuery({ queryKey: ["admin-access"], queryFn: () => fetchAccess({}) });
  const users = useQuery({ queryKey: ["admin-users"], queryFn: () => fetchUsers({}) });

  async function refresh() {
    await Promise.all([
      qc.invalidateQueries({ queryKey: ["admin-access"] }),
      qc.invalidateQueries({ queryKey: ["admin-users"] }),
      qc.invalidateQueries({ queryKey: ["admin-overview"] }),
    ]);
  }

  async function run(id: string, action: () => Promise<unknown>, message: string) {
    setBusy(id);
    try {
      await action();
      await refresh();
      toast.success(message);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Action failed.");
    } finally {
      setBusy(null);
    }
  }

  if (access.isPending || users.isPending)
    return <div className="h-48 animate-pulse rounded-md bg-muted" />;
  if (access.error || users.error) {
    return <p className="text-sm text-destructive">{String(access.error ?? users.error)}</p>;
  }

  const userRows = users.data ?? [];
  const emailById = new Map(userRows.map((user) => [user.id, user.email]));
  const currentSecretByUser = new Map(
    (access.data?.secrets ?? [])
      .filter((secret) => secret.status !== "revoked")
      .map((secret) => [secret.user_id, secret]),
  );

  return (
    <div className="space-y-6">
      {revealedSecret ? (
        <Card className="border-primary/40">
          <CardHeader>
            <CardTitle className="text-base">One-time access secret</CardTitle>
            <CardDescription>
              Securely send this to {revealedSecret.email}. It cannot be recovered later.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <code className="block break-all rounded-md bg-muted p-3 text-sm">
              {revealedSecret.secret}
            </code>
            <Button onClick={() => setRevealedSecret(null)}>I saved it</Button>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Waitlist requests</CardTitle>
          <CardDescription>Approve an application to send the account invitation.</CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Applicant</TableHead>
                <TableHead>Phone</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(access.data?.requests ?? []).map((request) => (
                <TableRow key={request.id}>
                  <TableCell>
                    <div className="font-medium">{request.full_name}</div>
                    <div className="text-xs text-muted-foreground">{request.email_normalized}</div>
                  </TableCell>
                  <TableCell>{request.phone_e164}</TableCell>
                  <TableCell>
                    <Badge
                      variant={
                        request.status === "approved"
                          ? "default"
                          : request.status === "rejected"
                            ? "destructive"
                            : "secondary"
                      }
                    >
                      {request.status}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-2">
                      {request.status === "pending" ? (
                        <>
                          <Button
                            size="sm"
                            disabled={busy === request.id}
                            onClick={() =>
                              void run(
                                request.id,
                                () =>
                                  review({ data: { requestId: request.id, decision: "approved" } }),
                                "Applicant approved and invited.",
                              )
                            }
                          >
                            Approve
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={busy === request.id}
                            onClick={() =>
                              void run(
                                request.id,
                                () =>
                                  review({ data: { requestId: request.id, decision: "rejected" } }),
                                "Application rejected.",
                              )
                            }
                          >
                            Reject
                          </Button>
                        </>
                      ) : null}
                      {busy === request.id ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">User access secrets</CardTitle>
          <CardDescription>
            Each approved user may have one usable secret and up to five browser activations.
          </CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>User</TableHead>
                <TableHead>Secret</TableHead>
                <TableHead>Activations</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {userRows
                .filter((user) => user.approval_status === "approved")
                .map((user) => {
                  const current = currentSecretByUser.get(user.id);
                  return (
                    <TableRow key={user.id}>
                      <TableCell>{user.email}</TableCell>
                      <TableCell>
                        {current ? (
                          <>
                            <Badge
                              variant={current.status === "exhausted" ? "secondary" : "default"}
                            >
                              {current.status}
                            </Badge>
                            <span className="ml-2 font-mono text-xs">
                              ••••{current.secret_suffix}
                            </span>
                          </>
                        ) : (
                          <span className="text-muted-foreground">Not issued</span>
                        )}
                      </TableCell>
                      <TableCell>
                        {current
                          ? `${current.activation_count} of ${current.max_activations}`
                          : "—"}
                      </TableCell>
                      <TableCell>
                        <div className="flex justify-end gap-2">
                          {current ? (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={busy === current.id}
                              onClick={() => {
                                if (
                                  window.confirm(
                                    `Revoke access for ${user.email}? Existing trusted browsers will be blocked immediately.`,
                                  )
                                )
                                  void run(
                                    current.id,
                                    () =>
                                      revoke({
                                        data: {
                                          secretId: current.id,
                                          reason: "Revoked by administrator",
                                        },
                                      }),
                                    "Access revoked.",
                                  );
                              }}
                            >
                              <ShieldX className="mr-2 h-4 w-4" />
                              Revoke
                            </Button>
                          ) : (
                            <Button
                              size="sm"
                              disabled={busy === user.id}
                              onClick={() =>
                                void run(
                                  user.id,
                                  async () => {
                                    const result = await issue({ data: { userId: user.id } });
                                    setRevealedSecret({ email: user.email, secret: result.secret });
                                  },
                                  "Access secret issued.",
                                )
                              }
                            >
                              <KeyRound className="mr-2 h-4 w-4" />
                              Issue secret
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

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Recent security events</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            {(access.data?.events ?? []).map((event) => (
              <div key={event.id} className="flex justify-between gap-4 border-b py-2 text-sm">
                <span>{event.event_type.replaceAll("_", " ")}</span>
                <span className="text-muted-foreground">
                  {new Date(event.created_at).toLocaleString()} ·{" "}
                  {event.user_id
                    ? (emailById.get(event.user_id) ?? event.user_id.slice(0, 8))
                    : "system"}
                </span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
