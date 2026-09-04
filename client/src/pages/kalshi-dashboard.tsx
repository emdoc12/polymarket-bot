import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { Link } from "wouter";
import { BrainCircuit, Trophy, Wallet, Activity } from "lucide-react";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

// Categorical series palette — validated with the dataviz six-checks script
// against the app's dark card surface (#13151B). Fixed assignment order;
// color follows the strategy, never its rank on a given render.
const SERIES_COLORS = ["#6B8AFB", "#B5862B", "#33A97C", "#B573CF"];

type ExecutorStatus = {
  enabled: boolean;
  dryRun: boolean;
  kalshiConfigured: boolean;
  promotedStrategies: number;
  openTrades: number;
  tradesToday: number;
  maxTradesPerDay: number;
  totalSettled: number;
  totalNetPnl: number;
};

type ExecutorTradeRow = {
  id: number;
  candidateId: number | null;
  candidateName: string;
  ticker: string;
  side: string;
  entryPrice: number;
  contracts: number;
  status: string;
  netPnl: number | null;
  placedAt: string;
  settledAt: string | null;
};

type LiveStatus = {
  enabled: boolean;
  killSwitch: string;
  killSwitchReason: string | null;
  prodConfigured: boolean;
  balanceCents: number | null;
  armedStrategies: { id: number; name: string }[];
  openTrades: number;
  tradesToday: number;
  maxTradesPerDay: number;
  totalSettled: number;
  totalNetPnl: number;
};

type LiveTradeRow = {
  id: number;
  candidateName: string;
  ticker: string;
  side: string;
  entryPrice: number;
  contracts: number;
  cost: number;
  status: string;
  netPnl: number | null;
  placedAt: string;
};

type Candidate = {
  id: number;
  name: string;
  status: string;
  createdBy: string;
  spec: {
    series: string;
    sideRule: string;
    entrySecondsBeforeClose: number;
    minEntryPrice: number;
    maxEntryPrice: number;
  };
  live: { trades: number | null; wins: number | null; netPnl: number | null };
  demo: { trades: number | null; wins: number | null; netPnl: number | null };
  pmNotes: string | null;
};

type LabStatus = {
  enabled: boolean;
  cyclesToday: number;
  maxCyclesPerDay: number;
  candidates: { testing: number; promoted: number; rejected: number };
};

type LabRun = { id: number; ranAt: string; pmCommentary: string | null; focus: string | null };

function money(value: number | null | undefined, showSign = false) {
  if (value == null || !Number.isFinite(value)) return "—";
  const sign = value > 0 && showSign ? "+" : "";
  return `${sign}$${value.toFixed(2)}`;
}

function PnlText({ value }: { value: number | null | undefined }) {
  if (value == null) return <span className="text-muted-foreground">—</span>;
  return (
    <span className={cn("font-mono", value > 0 ? "text-profit" : value < 0 ? "text-loss" : "text-muted-foreground")}>
      {money(value, true)}
    </span>
  );
}

function describeSpec(spec: Candidate["spec"]) {
  return [
    spec.series.replace("KX", "").replace("15M", " 15m"),
    spec.sideRule.replace("_", " "),
    `T-${spec.entrySecondsBeforeClose}s`,
    `${(spec.minEntryPrice * 100).toFixed(0)}-${(spec.maxEntryPrice * 100).toFixed(0)}¢`,
  ].join(" · ");
}

const tickStyle = { fill: "hsl(var(--muted-foreground))", fontSize: 10 };
const gridStroke = "hsl(var(--border))";

function chartTooltipStyle() {
  return {
    backgroundColor: "hsl(var(--card))",
    border: "1px solid hsl(var(--card-border))",
    borderRadius: 6,
    fontSize: 11,
    color: "hsl(var(--card-foreground))",
  } as const;
}

export default function KalshiDashboard() {
  const { data: executor } = useQuery<ExecutorStatus>({
    queryKey: ["/api/executor/status"],
    refetchInterval: 10000,
  });
  const { data: seriesData } = useQuery<{ series: { t: string; pnl: number; name: string; real: boolean }[] }>({
    queryKey: ["/api/executor/pnl-series"],
    refetchInterval: 30000,
  });
  const { data: candidatesData } = useQuery<{ candidates: Candidate[] }>({
    queryKey: ["/api/agent-lab/candidates"],
    refetchInterval: 15000,
  });
  const { data: labStatus } = useQuery<LabStatus>({
    queryKey: ["/api/agent-lab/status"],
    refetchInterval: 15000,
  });
  const { data: runsData } = useQuery<{ runs: LabRun[] }>({
    queryKey: ["/api/agent-lab/runs"],
    refetchInterval: 30000,
  });
  const { data: balance } = useQuery<{ balance: number }>({
    queryKey: ["/api/kalshi/balance"],
    refetchInterval: 60000,
    retry: false,
  });
  const { data: liveStatus } = useQuery<LiveStatus>({
    queryKey: ["/api/live/status"],
    refetchInterval: 15000,
    retry: false,
  });
  const { data: liveTradesData } = useQuery<{ trades: LiveTradeRow[] }>({
    queryKey: ["/api/live/trades"],
    refetchInterval: 15000,
    retry: false,
  });
  const { data: livePnlData } = useQuery<{ series: { t: string; pnl: number; name: string }[] }>({
    queryKey: ["/api/live/pnl-series"],
    refetchInterval: 30000,
    retry: false,
  });

  const candidates = candidatesData?.candidates ?? [];
  const promoted = candidates.filter((c) => c.status === "promoted");

  // Full settled history in time order drives both cumulative charts, split
  // into real exchange fills vs dry-run rehearsal so the two are never mixed.
  const settled = seriesData?.series ?? [];

  let cumReal = 0;
  let cumRehearsal = 0;
  const overallSeries = settled.map((t) => {
    if (t.real) cumReal += t.pnl;
    else cumRehearsal += t.pnl;
    return {
      time: new Date(t.t).getTime(),
      real: Number(cumReal.toFixed(2)),
      rehearsal: Number(cumRehearsal.toFixed(2)),
    };
  });
  const realStats = settled.filter((t) => t.real);
  const realPnl = realStats.reduce((s, t) => s + t.pnl, 0);
  const rehearsalPnl = cumRehearsal;

  // Top strategies by settled demo P&L; colors assigned once, in rank order at
  // first paint, then follow the strategy name.
  const byStrategy = new Map<string, number>();
  for (const t of settled) {
    byStrategy.set(t.name, (byStrategy.get(t.name) ?? 0) + t.pnl);
  }
  const topStrategies = [...byStrategy.entries()]
    .map(([name, total]) => ({ name, total }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 4)
    .map((entry, i) => ({ ...entry, color: SERIES_COLORS[i] }));

  // Build cumulative per-strategy points keyed by time.
  const cumByStrategy = new Map<string, number>();
  const perStrategyPoints = settled
    .filter((t) => topStrategies.some((s) => s.name === t.name))
    .map((point) => {
      const next = (cumByStrategy.get(point.name) ?? 0) + point.pnl;
      cumByStrategy.set(point.name, next);
      const row: Record<string, number | string | null> = { time: new Date(point.t).getTime() };
      for (const s of topStrategies) {
        row[s.name] = s.name === point.name ? Number(next.toFixed(2)) : (cumByStrategy.get(s.name) ?? null);
      }
      return row;
    });

  const timeFmt = (ms: number) =>
    new Date(ms).toLocaleString(undefined, { month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit" });

  const lastCommentary = (runsData?.runs ?? []).find((r) => r.pmCommentary);
  const balanceDollars = balance?.balance != null ? balance.balance / 100 : null;

  // Live (real-money) section only appears once prod is set up or trades exist.
  const liveTrades = liveTradesData?.trades ?? [];
  const showLive = Boolean(liveStatus?.prodConfigured || liveStatus?.enabled || liveTrades.length > 0);
  let cumLive = 0;
  const liveSeries = (livePnlData?.series ?? []).map((t) => {
    cumLive += t.pnl;
    return { time: new Date(t.t).getTime(), live: Number(cumLive.toFixed(2)) };
  });
  const liveBalanceDollars = liveStatus?.balanceCents != null ? liveStatus.balanceCents / 100 : null;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold tracking-tight">Dashboard</h2>
        <p className="text-sm text-muted-foreground mt-0.5">
          Kalshi demo account · agent-researched strategies
        </p>
      </div>

      {/* Stat tiles */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Card>
          <CardContent className="py-3 px-4">
            <p className="text-xs text-muted-foreground flex items-center gap-1"><Wallet className="w-3 h-3" /> Demo balance</p>
            <p className="text-lg font-semibold font-mono mt-0.5">
              {balanceDollars != null ? `$${balanceDollars.toFixed(2)}` : "—"}
            </p>
            {balanceDollars == null && (
              <p className="text-[11px] text-muted-foreground">connect Kalshi key in Settings</p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardContent className="py-3 px-4">
            <p className="text-xs text-muted-foreground flex items-center gap-1"><Activity className="w-3 h-3" /> Real P&L (exchange fills)</p>
            <p className="text-lg font-semibold mt-0.5"><PnlText value={settled.length > 0 ? realPnl : null} /></p>
            <p className="text-[11px] text-muted-foreground">
              {realStats.length}/300 real fills toward graduation · rehearsal {money(rehearsalPnl, true)}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="py-3 px-4">
            <p className="text-xs text-muted-foreground flex items-center gap-1"><Trophy className="w-3 h-3" /> Armed strategies</p>
            <p className="text-lg font-semibold font-mono mt-0.5">{executor?.promotedStrategies ?? "—"}</p>
            <p className="text-[11px] text-muted-foreground">
              {executor?.enabled
                ? executor.dryRun ? "executing (dry run)" : "executing live on demo"
                : "execution off"}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="py-3 px-4">
            <p className="text-xs text-muted-foreground flex items-center gap-1"><BrainCircuit className="w-3 h-3" /> Research</p>
            <p className="text-lg font-semibold font-mono mt-0.5">
              {labStatus ? `${labStatus.cyclesToday}/${labStatus.maxCyclesPerDay}` : "—"}
            </p>
            <p className="text-[11px] text-muted-foreground">
              {labStatus ? `${labStatus.candidates.testing} testing · ${labStatus.candidates.promoted} promoted` : "cycles today"}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Live (real-money) trading */}
      {showLive && (
        <Card className={liveStatus?.enabled ? "border-destructive/40" : undefined}>
          <CardHeader className="pb-2">
            <div className="flex items-center gap-2">
              <CardTitle className="text-sm font-medium">Live account — real money</CardTitle>
              {liveStatus?.enabled ? (
                <Badge variant="destructive" className="text-[10px]">ARMED</Badge>
              ) : (
                <Badge variant="secondary" className="text-[10px]">disarmed</Badge>
              )}
              {liveStatus?.killSwitch === "tripped" && (
                <Badge variant="destructive" className="text-[10px]">KILL SWITCH</Badge>
              )}
            </div>
            <CardDescription className="text-xs">
              Production Kalshi account, tracked completely separately from the demo pipeline.
              Arm/disarm from <Link href="/settings" className="underline">Settings</Link>.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              <div>
                <p className="text-xs text-muted-foreground">Live balance</p>
                <p className="text-base font-semibold font-mono">
                  {liveBalanceDollars != null ? `$${liveBalanceDollars.toFixed(2)}` : "—"}
                </p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Live P&L (settled)</p>
                <p className="text-base font-semibold">
                  <PnlText value={(liveStatus?.totalSettled ?? 0) > 0 ? liveStatus?.totalNetPnl : null} />
                </p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Open / today</p>
                <p className="text-base font-semibold font-mono">
                  {liveStatus ? `${liveStatus.openTrades} · ${liveStatus.tradesToday}/${liveStatus.maxTradesPerDay}` : "—"}
                </p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Allowlisted strategies</p>
                <p className="text-base font-semibold font-mono">{liveStatus?.armedStrategies.length ?? "—"}</p>
              </div>
            </div>

            {liveSeries.length >= 2 && (
              <div className="h-44">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={liveSeries} margin={{ top: 6, right: 12, bottom: 0, left: 0 }}>
                    <CartesianGrid stroke={gridStroke} strokeOpacity={0.4} vertical={false} />
                    <XAxis
                      dataKey="time" type="number" scale="time" domain={["dataMin", "dataMax"]}
                      tickFormatter={timeFmt} tick={tickStyle} axisLine={false} tickLine={false} minTickGap={60}
                    />
                    <YAxis
                      tickFormatter={(v: number) => `$${v}`} tick={tickStyle}
                      axisLine={false} tickLine={false} width={48}
                    />
                    <Tooltip
                      contentStyle={chartTooltipStyle()}
                      labelFormatter={(v) => timeFmt(Number(v))}
                      formatter={(value, name) => [money(Number(value), true), String(name)]}
                    />
                    <Line
                      type="monotone" dataKey="live" stroke={SERIES_COLORS[2]} strokeWidth={2}
                      dot={false} activeDot={{ r: 4 }} name="Live P&L"
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}

            {liveTrades.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-[11px] text-muted-foreground border-b border-border">
                      <th className="text-left font-medium py-2 pr-3">Strategy</th>
                      <th className="text-left font-medium px-3 py-2">Market</th>
                      <th className="text-right font-medium px-3 py-2">Entry</th>
                      <th className="text-right font-medium px-3 py-2 hidden sm:table-cell">Cost</th>
                      <th className="text-left font-medium px-3 py-2">Status</th>
                      <th className="text-right font-medium pl-3 py-2">Net P&L</th>
                    </tr>
                  </thead>
                  <tbody>
                    {liveTrades.slice(0, 12).map((t) => (
                      <tr key={t.id} className="border-b border-border/50">
                        <td className="py-2 pr-3 text-xs font-medium">{t.candidateName}</td>
                        <td className="px-3 py-2 text-[11px] font-mono text-muted-foreground">
                          {t.ticker} · {t.side.toUpperCase()}
                        </td>
                        <td className="px-3 py-2 text-right text-xs font-mono">
                          {t.contracts > 0 ? `${t.contracts} @ ${(t.entryPrice * 100).toFixed(0)}¢` : "—"}
                        </td>
                        <td className="px-3 py-2 text-right text-xs font-mono hidden sm:table-cell">{money(t.cost)}</td>
                        <td className="px-3 py-2 text-xs">
                          <Badge
                            variant={t.status === "settled_won" ? "default" : t.status === "settled_lost" || t.status === "failed" ? "destructive" : "secondary"}
                            className="text-[10px]"
                          >
                            {t.status.replace("settled_", "")}
                          </Badge>
                        </td>
                        <td className="pl-3 py-2 text-right text-xs"><PnlText value={t.netPnl} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                No live trades yet{liveStatus?.enabled ? " — waiting for the next qualifying entry window." : " — live trading is disarmed."}
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {/* Cumulative P&L */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">Cumulative demo P&L — real vs rehearsal</CardTitle>
          <CardDescription className="text-xs">
            Full settled history, after fees. Real = actual exchange fills; rehearsal = dry-run scoring at
            quoted prices. The gap between the curves is execution reality.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {overallSeries.length < 2 ? (
            <p className="text-xs text-muted-foreground py-6 text-center">
              Not enough settled demo trades yet — the curves appear once promoted strategies start settling.
            </p>
          ) : (
            <div className="h-56">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={overallSeries} margin={{ top: 6, right: 12, bottom: 0, left: 0 }}>
                  <CartesianGrid stroke={gridStroke} strokeOpacity={0.4} vertical={false} />
                  <XAxis
                    dataKey="time" type="number" scale="time" domain={["dataMin", "dataMax"]}
                    tickFormatter={timeFmt} tick={tickStyle} axisLine={false} tickLine={false} minTickGap={60}
                  />
                  <YAxis
                    tickFormatter={(v: number) => `$${v}`} tick={tickStyle}
                    axisLine={false} tickLine={false} width={48}
                  />
                  <Tooltip
                    contentStyle={chartTooltipStyle()}
                    labelFormatter={(v) => timeFmt(Number(v))}
                    formatter={(value, name) => [money(Number(value), true), String(name)]}
                  />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Line
                    type="monotone" dataKey="real" stroke={SERIES_COLORS[0]} strokeWidth={2}
                    dot={false} activeDot={{ r: 4 }} name="Real fills"
                  />
                  <Line
                    type="monotone" dataKey="rehearsal" stroke={SERIES_COLORS[1]} strokeWidth={2}
                    dot={false} activeDot={{ r: 4 }} name="Rehearsal (dry-run)"
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Per-strategy P&L */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">Top strategies — cumulative P&L</CardTitle>
          <CardDescription className="text-xs">
            Up to four strategies with the largest settled demo P&L.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {perStrategyPoints.length < 2 ? (
            <p className="text-xs text-muted-foreground py-6 text-center">
              Waiting on settled demo trades per strategy.
            </p>
          ) : (
            <div className="h-56">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={perStrategyPoints} margin={{ top: 6, right: 12, bottom: 0, left: 0 }}>
                  <CartesianGrid stroke={gridStroke} strokeOpacity={0.4} vertical={false} />
                  <XAxis
                    dataKey="time" type="number" scale="time" domain={["dataMin", "dataMax"]}
                    tickFormatter={timeFmt} tick={tickStyle} axisLine={false} tickLine={false} minTickGap={60}
                  />
                  <YAxis
                    tickFormatter={(v: number) => `$${v}`} tick={tickStyle}
                    axisLine={false} tickLine={false} width={48}
                  />
                  <Tooltip
                    contentStyle={chartTooltipStyle()}
                    labelFormatter={(v) => timeFmt(Number(v))}
                    formatter={(value, name) => [money(Number(value), true), String(name)]}
                  />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  {topStrategies.map((s) => (
                    <Line
                      key={s.name} type="monotone" dataKey={s.name} stroke={s.color} strokeWidth={2}
                      dot={false} activeDot={{ r: 4 }} connectNulls
                    />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Earnings table */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">Promoted strategies — earnings</CardTitle>
          <CardDescription className="text-xs">
            Demo = real orders on the demo account. Walk-forward = simulated on markets settled after proposal.
            Full history on the <Link href="/lab" className="underline">Strategy Lab</Link> page.
          </CardDescription>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          {promoted.length === 0 ? (
            <p className="text-xs text-muted-foreground px-5 pb-4">
              No promoted strategies yet — the lab promotes candidates whose edge survives walk-forward testing.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-[11px] text-muted-foreground border-b border-border">
                    <th className="text-left font-medium px-5 py-2">Strategy</th>
                    <th className="text-right font-medium px-3 py-2">Demo P&L</th>
                    <th className="text-right font-medium px-3 py-2">Demo W/L</th>
                    <th className="text-right font-medium px-3 py-2">Walk-forward P&L</th>
                    <th className="text-right font-medium px-3 py-2 hidden sm:table-cell">WF trades</th>
                    <th className="text-left font-medium px-5 py-2 hidden lg:table-cell">PM note</th>
                  </tr>
                </thead>
                <tbody>
                  {[...promoted]
                    .sort((a, b) => (b.demo.netPnl ?? b.live.netPnl ?? 0) - (a.demo.netPnl ?? a.live.netPnl ?? 0))
                    .map((c) => {
                      const colorIdx = topStrategies.findIndex((s) => s.name === c.name);
                      return (
                        <tr key={c.id} className="border-b border-border/50 align-top">
                          <td className="px-5 py-2.5">
                            <div className="flex items-center gap-2">
                              {colorIdx >= 0 && (
                                <span
                                  className="inline-block w-2 h-2 rounded-full shrink-0"
                                  style={{ backgroundColor: topStrategies[colorIdx].color }}
                                />
                              )}
                              <p className="text-xs font-medium">{c.name}</p>
                            </div>
                            <p className="text-[11px] text-muted-foreground">{describeSpec(c.spec)}</p>
                          </td>
                          <td className="px-3 py-2.5 text-right text-xs"><PnlText value={c.demo.netPnl} /></td>
                          <td className="px-3 py-2.5 text-right text-xs font-mono text-muted-foreground">
                            {c.demo.trades ? `${c.demo.wins ?? 0}/${(c.demo.trades ?? 0) - (c.demo.wins ?? 0)}` : "—"}
                          </td>
                          <td className="px-3 py-2.5 text-right text-xs"><PnlText value={c.live.netPnl} /></td>
                          <td className="px-3 py-2.5 text-right text-xs font-mono text-muted-foreground hidden sm:table-cell">
                            {c.live.trades ?? "—"}
                          </td>
                          <td className="px-5 py-2.5 hidden lg:table-cell">
                            <p className="text-[11px] text-muted-foreground max-w-sm">{c.pmNotes ?? ""}</p>
                          </td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Latest PM commentary */}
      {lastCommentary && (
        <Card className="border-primary/20 bg-primary/5">
          <CardContent className="py-4 px-5">
            <div className="flex items-center gap-2 mb-1.5">
              <BrainCircuit className="w-4 h-4 text-primary" />
              <h3 className="text-sm font-medium">Latest PM read</h3>
              <Badge variant="outline" className="text-[10px]">
                {new Date(lastCommentary.ranAt).toLocaleString()}
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground">{lastCommentary.pmCommentary}</p>
            {lastCommentary.focus && (
              <p className="text-[11px] text-muted-foreground mt-1.5">
                <span className="font-medium text-foreground/80">Next focus:</span> {lastCommentary.focus}
              </p>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
