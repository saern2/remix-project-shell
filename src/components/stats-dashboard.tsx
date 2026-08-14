import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  Bar,
  BarChart,
  Cell,
  Pie,
  PieChart,
  ReferenceLine,
  ResponsiveContainer,
  XAxis,
  YAxis,
} from "recharts";
import { ArrowDown, ArrowUp, BarChart3 } from "lucide-react";

import { getGenerationStats, type GenerationStats } from "@/lib/stats.functions";
import { useIsAdmin } from "@/hooks/use-is-admin";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

type TimeWindow = "today" | "lifetime";
type Scope = "user" | "platform";

/** Outcome colours, reused by the donut and the table badges so they agree. */
const OUTCOME_STYLE: Record<string, { fill: string; label: string; badge: string }> = {
  completed: {
    fill: "hsl(var(--primary))",
    label: "Completed",
    badge: "bg-primary/10 text-primary border-primary/20",
  },
  failed: {
    fill: "hsl(var(--destructive))",
    label: "Failed",
    badge: "bg-destructive/10 text-destructive border-destructive/20",
  },
  cancelled: {
    fill: "hsl(var(--muted-foreground))",
    label: "Cancelled",
    badge: "bg-muted text-muted-foreground border-border",
  },
};

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function formatSeconds(seconds: number | null): string {
  if (seconds == null) return "—";
  const total = Math.round(seconds);
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return minutes > 0 ? `${minutes}m ${String(rest).padStart(2, "0")}s` : `${rest}s`;
}

function formatMs(ms: number | null): string {
  if (ms == null) return "—";
  return formatSeconds(ms / 1000);
}

/**
 * A KPI tile: big number, small label, and a delta against the previous
 * equivalent period when one exists.
 *
 * `delta` is deliberately optional rather than defaulting to zero — lifetime
 * has no previous period, and a "0%" there would be a claim we cannot make.
 */
function KpiCard({
  label,
  value,
  sub,
  delta,
  loading,
}: {
  label: string;
  value: string;
  sub?: string;
  delta?: { value: number; suffix?: string } | null;
  loading?: boolean;
}) {
  if (loading) {
    return (
      <Card>
        <CardContent className="space-y-2 pt-6">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-9 w-28" />
          <Skeleton className="h-3 w-20" />
        </CardContent>
      </Card>
    );
  }

  const up = delta != null && delta.value > 0;
  const down = delta != null && delta.value < 0;

  return (
    <Card>
      <CardContent className="pt-6">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
        <p className="mt-2 text-3xl font-semibold tabular-nums">{value}</p>
        <div className="mt-1 flex min-h-5 items-center gap-2">
          {delta != null && delta.value !== 0 ? (
            <span
              className={cn(
                "flex items-center gap-0.5 text-xs font-medium",
                up && "text-emerald-600 dark:text-emerald-400",
                down && "text-destructive",
              )}
            >
              {up ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />}
              {Math.abs(delta.value)}
              {delta.suffix ?? ""}
            </span>
          ) : null}
          {sub ? <span className="text-xs text-muted-foreground">{sub}</span> : null}
        </div>
      </CardContent>
    </Card>
  );
}

function EmptyPanel({ message }: { message: string }) {
  return (
    <div className="flex h-full min-h-40 flex-col items-center justify-center gap-2 text-center">
      <BarChart3 className="h-6 w-6 text-muted-foreground/60" />
      <p className="text-sm text-muted-foreground">{message}</p>
    </div>
  );
}

export function StatsDashboard() {
  const { isAdmin } = useIsAdmin();
  const [scope, setScope] = useState<Scope>("user");
  const [timeWindow, setTimeWindow] = useState<TimeWindow>("lifetime");
  const runStats = useServerFn(getGenerationStats);

  // Resolved once per mount: "today" is computed in the viewer's zone so an
  // evening in UTC-7 is not reported as an empty day.
  const timeZone = useMemo(() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    } catch {
      return "UTC";
    }
  }, []);

  // The Platform toggle is only ever rendered for an admin, and isAdmin is
  // false while loading, so a non-admin can never briefly see it. A stale
  // "platform" selection is also clamped here rather than sent and refused.
  const effectiveScope: Scope = isAdmin && scope === "platform" ? "platform" : "user";

  const statsQuery = useQuery({
    queryKey: ["generation-stats", effectiveScope, timeZone],
    queryFn: () =>
      runStats({ data: { scope: effectiveScope, timeZone } }) as Promise<GenerationStats>,
    staleTime: 30_000,
  });

  const stats = statsQuery.data;
  const loading = statsQuery.isPending;
  const period = timeWindow === "today" ? stats?.today : stats?.lifetime;

  const successRate = useMemo(() => {
    if (!period || period.total === 0) return null;
    return {
      pct: Math.round((period.completed / period.total) * 100),
      completed: period.completed,
      total: period.total,
    };
  }, [period]);

  const dailyAverage = useMemo(() => {
    if (!stats?.daily?.length) return 0;
    const sum = stats.daily.reduce((total, day) => total + day.count, 0);
    return sum / stats.daily.length;
  }, [stats]);

  const chartData = useMemo(
    () =>
      (stats?.daily ?? []).map((day) => ({
        ...day,
        // Sparse labelling: 30 dates do not fit, so only a few are drawn.
        label: new Date(`${day.day}T00:00:00Z`).toLocaleDateString(undefined, {
          day: "numeric",
          month: "short",
        }),
      })),
    [stats],
  );

  const outcomeTotal = (stats?.outcomes ?? []).reduce((total, row) => total + row.count, 0);
  const rankedMax = Math.max(1, ...(stats?.ranked ?? []).map((row) => row.count));
  const hasAnyEvents = (stats?.lifetime.total ?? 0) > 0;

  // Delta only where a previous equivalent period exists: yesterday for Today,
  // nothing for Lifetime.
  const deltaFor = (key: "completed" | "total" | "seconds") => {
    if (timeWindow !== "today" || !stats) return null;
    return { value: stats.today[key] - stats.previous_day[key] };
  };

  // A lifetime total that silently mixes 391 reconstructed generations with 216
  // measured ones is exactly the kind of unlabelled number this project has
  // been bitten by. The label is built from the data, so it cannot drift from
  // what the RPC actually added.
  const baseline = stats?.baseline ?? null;
  const lifetimeLabel = baseline
    ? `Lifetime · includes ${baseline.generations_completed} generations from ` +
      `${formatDate(baseline.effective_from)}${stats?.range_start ? `–${formatDate(stats.range_start)}` : ""} ` +
      `reconstructed from operator records; per-video figures are estimates.`
    : stats?.range_start
      ? `Lifetime · recorded since ${formatDate(stats.range_start)}`
      : "Lifetime";

  if (statsQuery.isError) {
    return (
      <Card>
        <CardContent className="pt-6">
          <p className="text-sm text-destructive">
            {(statsQuery.error as Error).message || "Statistics could not be loaded."}
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Stats</h1>
          <p className="text-sm text-muted-foreground">
            {effectiveScope === "platform" ? "Every account on the platform." : "Your generations."}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {isAdmin ? (
            <Tabs value={scope} onValueChange={(next) => setScope(next as Scope)}>
              <TabsList>
                <TabsTrigger value="user">My stats</TabsTrigger>
                <TabsTrigger value="platform">Platform</TabsTrigger>
              </TabsList>
            </Tabs>
          ) : null}
          <Tabs value={timeWindow} onValueChange={(next) => setTimeWindow(next as TimeWindow)}>
            <TabsList>
              <TabsTrigger value="today">Today</TabsTrigger>
              <TabsTrigger value="lifetime">Lifetime</TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
      </div>

      {!loading && !hasAnyEvents ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center gap-2 py-16 text-center">
            <BarChart3 className="h-8 w-8 text-muted-foreground/60" />
            <p className="text-base font-medium">No generations yet</p>
            <p className="max-w-sm text-sm text-muted-foreground">
              {effectiveScope === "platform"
                ? "Nothing has been recorded yet. Completed and failed generations appear here as they finish."
                : "Turn an audio file into a video and it will appear here."}
            </p>
          </CardContent>
        </Card>
      ) : null}

      {/* ── KPI row ─────────────────────────────────────────────────────── */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          loading={loading}
          label="Videos generated"
          value={String(period?.completed ?? 0)}
          sub={timeWindow === "lifetime" ? lifetimeLabel : "Today"}
          delta={deltaFor("completed")}
        />
        <KpiCard
          loading={loading}
          label="Success rate"
          // The denominator is not optional: "100%" alone, with no failures in
          // the data, reads as a placeholder rather than a measurement.
          value={successRate ? `${successRate.pct}%` : "—"}
          sub={
            successRate
              ? `${successRate.completed} of ${successRate.total}`
              : timeWindow === "today"
                ? "No generations today"
                : "No generations recorded"
          }
        />
        <KpiCard
          loading={loading}
          label="Video minutes"
          value={String(Math.round((period?.seconds ?? 0) / 60))}
          sub={timeWindow === "lifetime" ? lifetimeLabel : "Today"}
          delta={
            timeWindow === "today" && stats
              ? {
                  value:
                    Math.round(stats.today.seconds / 60) -
                    Math.round(stats.previous_day.seconds / 60),
                }
              : null
          }
        />
        <KpiCard
          loading={loading}
          label="Currently active"
          value={String(stats?.active_now ?? 0)}
          // Deliberately not affected by the Today/Lifetime toggle: this is
          // current state read from projects, not recorded history.
          sub="Rendering or matching now"
        />
      </div>

      {/* The provenance in full, from the database rather than from this file,
          so whoever edits the baseline edits its explanation with it. Shown
          only where the baseline is actually in the numbers above: the Lifetime
          window of the platform scope. */}
      {baseline && timeWindow === "lifetime" && !loading ? (
        <p className="text-xs leading-relaxed text-muted-foreground">
          <span className="font-medium">Lifetime totals include a reconstructed baseline.</span>{" "}
          {baseline.note}
        </p>
      ) : null}

      {/* ── 30-day chart ────────────────────────────────────────────────── */}
      <Card>
        <CardHeader className="flex flex-row items-start justify-between space-y-0">
          <div>
            <CardTitle className="text-base">Videos generated per day</CardTitle>
            <p className="text-sm text-muted-foreground">
              Last 30 days. Independent of the Today/Lifetime selection.
            </p>
          </div>
          {!loading && stats ? (
            <p className="text-right text-xs text-muted-foreground">
              Average
              <span className="ml-1 font-medium text-foreground tabular-nums">
                {dailyAverage.toFixed(1)}/day
              </span>
            </p>
          ) : null}
        </CardHeader>
        <CardContent>
          {loading ? (
            <Skeleton className="h-56 w-full" />
          ) : (
            <ResponsiveContainer width="100%" height={224}>
              <BarChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: -20 }}>
                <XAxis
                  dataKey="label"
                  tickLine={false}
                  axisLine={false}
                  interval={6}
                  tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
                />
                <YAxis
                  allowDecimals={false}
                  tickLine={false}
                  axisLine={false}
                  width={40}
                  tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
                />
                {/* Dashed mean across the window. */}
                <ReferenceLine
                  y={dailyAverage}
                  stroke="hsl(var(--muted-foreground))"
                  strokeDasharray="4 4"
                  strokeOpacity={0.7}
                />
                <Bar
                  dataKey="count"
                  radius={[3, 3, 0, 0]}
                  fill="hsl(var(--primary))"
                  // A day with no generations is a real zero, so it keeps its
                  // slot on the axis instead of collapsing the window.
                  minPointSize={0}
                />
              </BarChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>

      {/* ── Supporting row ──────────────────────────────────────────────── */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Outcomes</CardTitle>
            <p className="text-sm text-muted-foreground">All recorded history.</p>
          </CardHeader>
          <CardContent>
            {loading ? (
              <Skeleton className="h-48 w-full" />
            ) : outcomeTotal === 0 ? (
              <EmptyPanel message="No outcomes recorded yet." />
            ) : (
              <div className="flex flex-col items-center gap-4 sm:flex-row">
                <ResponsiveContainer width="100%" height={180} className="max-w-[180px]">
                  <PieChart>
                    <Pie
                      data={stats?.outcomes ?? []}
                      dataKey="count"
                      nameKey="event_type"
                      innerRadius={52}
                      outerRadius={78}
                      paddingAngle={outcomeTotal > 0 && (stats?.outcomes.length ?? 0) > 1 ? 2 : 0}
                      strokeWidth={0}
                    >
                      {(stats?.outcomes ?? []).map((row) => (
                        <Cell
                          key={row.event_type}
                          fill={OUTCOME_STYLE[row.event_type]?.fill ?? "hsl(var(--muted))"}
                        />
                      ))}
                    </Pie>
                  </PieChart>
                </ResponsiveContainer>
                <ul className="w-full space-y-2">
                  {(stats?.outcomes ?? []).map((row) => (
                    <li key={row.event_type} className="flex items-center gap-2 text-sm">
                      <span
                        className="h-2.5 w-2.5 shrink-0 rounded-full"
                        style={{
                          background: OUTCOME_STYLE[row.event_type]?.fill ?? "hsl(var(--muted))",
                        }}
                      />
                      <span className="flex-1">
                        {OUTCOME_STYLE[row.event_type]?.label ?? row.event_type}
                      </span>
                      <span className="tabular-nums text-muted-foreground">
                        {Math.round((row.count / outcomeTotal) * 100)}%
                      </span>
                      <span className="w-8 text-right tabular-nums font-medium">{row.count}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {effectiveScope === "platform"
                ? "Generations by user"
                : "Generations by project size"}
            </CardTitle>
            <p className="text-sm text-muted-foreground">
              {effectiveScope === "platform" ? "Top 10, completed only." : "Scenes per project."}
            </p>
          </CardHeader>
          <CardContent>
            {loading ? (
              <Skeleton className="h-48 w-full" />
            ) : (stats?.ranked.length ?? 0) === 0 ? (
              <EmptyPanel message="Nothing to rank yet." />
            ) : (
              <ul className="space-y-3">
                {(stats?.ranked ?? []).map((row) => (
                  <li key={row.label} className="space-y-1">
                    <div className="flex items-baseline justify-between gap-3 text-sm">
                      <span className="truncate">{row.label}</span>
                      <span className="tabular-nums font-medium">{row.count}</span>
                    </div>
                    <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full rounded-full bg-primary transition-[width]"
                        style={{ width: `${(row.count / rankedMax) * 100}%` }}
                      />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      {/* ── Recent table ────────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Recent generations</CardTitle>
          <p className="text-sm text-muted-foreground">
            Render time is measured from render start to finish, so it includes downloading clips —
            not encoding alone.
          </p>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="space-y-2">
              {Array.from({ length: 5 }, (_, index) => (
                <Skeleton key={index} className="h-9 w-full" />
              ))}
            </div>
          ) : (stats?.recent.length ?? 0) === 0 ? (
            <EmptyPanel message="No generations yet." />
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    {effectiveScope === "platform" ? <TableHead>User</TableHead> : null}
                    <TableHead>Outcome</TableHead>
                    <TableHead className="text-right">Scenes</TableHead>
                    <TableHead className="text-right">Audio</TableHead>
                    <TableHead className="text-right">Render time</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(stats?.recent ?? []).map((row) => (
                    <TableRow key={row.id}>
                      <TableCell className="whitespace-nowrap">
                        {formatDate(row.created_at)}
                        {row.backfilled ? (
                          <span
                            className="ml-2 text-xs text-muted-foreground"
                            title="Reconstructed from project history rather than captured as it happened"
                          >
                            recovered
                          </span>
                        ) : null}
                      </TableCell>
                      {effectiveScope === "platform" ? (
                        <TableCell className="max-w-[14rem] truncate">
                          {row.user_label ?? "—"}
                        </TableCell>
                      ) : null}
                      <TableCell>
                        <Badge
                          variant="outline"
                          className={cn(OUTCOME_STYLE[row.event_type]?.badge)}
                        >
                          {OUTCOME_STYLE[row.event_type]?.label ?? row.event_type}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {row.scene_count ?? "—"}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatSeconds(row.audio_duration_seconds)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatMs(row.render_duration_ms)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
