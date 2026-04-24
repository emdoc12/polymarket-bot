import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Bot, Activity, DollarSign, Trophy, TrendingDown, ShieldAlert, ShieldCheck, Wifi, Zap, TimerReset, Radar, CircleDot } from "lucide-react";
import { cn } from "@/lib/utils";
import type { TradeLog, Strategy } from "@shared/schema";

type EngineStatus = {
  running: boolean;
  mode: string;
  pollingIntervalSec: number;
  activeStrategies: number;
  openTrades: number;
  circuitBreaker: string;
  lastPollAt: string | null;
  lastPollOutcome: string | null;
  lastSignalAt: string | null;
  lastSignalStrategy: string | null;
  lastSignalReason: string | null;
  currentMarketId: string | null;
  currentConditionId: string | null;
  currentMarketQuestion: string | null;
  currentMarketRawQuestion: string | null;
  currentMarketEndsAt: string | null;
  currentMarketTimeLeftSec: number | null;
  currentYesPrice: number | null;
  currentNoPrice: number | null;
  strategyDiagnostics: {
    strategyId: number;
    strategyName: string;
    outcome: string;
    detail: string;
    score: number | null;
    checkedAt: string | null;
  }[];
  managerDecision: {
    chosenStrategyId: number | null;
    chosenStrategyName: string | null;
    action: string | null;
    side: "YES" | "NO" | null;
    score: number | null;
    reason: string | null;
    decidedAt: string | null;
  };
  marketDebug: {
    matchedEventTitles: string[];
    btcCandidateTitles: string[];
    selectorTarget: string | null;
    selectorCandidates: string[];
    selectorWinner: string | null;
  };
};

export default function Dashboard() {
  const { data: status } = useQuery<{
    mode: string;
    activeStrategies: number;
    totalStrategies: number;
    recentTrades: TradeLog[];
    openTrades: number;
  }>({ queryKey: ["/api/bot/status"], refetchInterval: 10000 });

  const { data: engine } = useQuery<EngineStatus>({
    queryKey: ["/api/engine/status"],
    refetchInterval: 5000,
  });

  const { data: strategies } = useQuery<Strategy[]>({
    queryKey: ["/api/strategies"],
    refetchInterval: 10000,
  });

  const { data: pnl } = useQuery<{
    totalPnl: number; totalWins: number; totalLosses: number; paperBalance: number;
    perStrategy: { id: number; name: string; totalPnl: number; winCount: number; lossCount: number; totalExecutions: number; winRate: string | null }[];
  }>({
    queryKey: ["/api/pnl"],
    refetchInterval: 15000,
  });

  const { data: safeguards } = useQuery<{
    drawdownPct: number; drawdownLimit: number; circuitBreaker: string;
    circuitBreakerAt: string | null; latencyMs: number | null;
    lagScore: number | null; polyPrice: number | null; chainlinkPrice: number | null;
  }>({
    queryKey: ["/api/safeguards"],
    refetchInterval: 30000,
  });

  const activeStrats = strategies?.filter((s) => s.isActive) || [];
  const recentTrades = status?.recentTrades || [];
  const totalExecutions = strategies?.reduce((sum, s) => sum + s.totalExecutions, 0) || 0;
  const paperBalance = pnl?.paperBalance ?? 1000;
  const totalPnl = pnl?.totalPnl ?? 0;
  const startBalance = 1000;
  const secondsToExpiry = engine?.currentMarketTimeLeftSec ?? (engine?.currentMarketEndsAt
    ? Math.max(0, Math.floor((new Date(engine.currentMarketEndsAt).getTime() - Date.now()) / 1000))
    : null);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">Dashboard</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            Bot overview and recent activity
          </p>
        </div>
        <Badge
          variant={status?.mode === "live" ? "default" : "secondary"}
          className="gap-1.5"
          data-testid="badge-mode"
        >
          <span className={`w-1.5 h-1.5 rounded-full ${status?.mode === "live" ? "bg-green-400 animate-pulse-dot" : "bg-muted-foreground"}`} />
          {status?.mode === "live" ? "Live" : "Paper"} Mode
        </Badge>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Paper Balance */}
        <Card>
          <CardContent className="pt-5 pb-4 px-5">
            <div className="flex items-start justify-between">
              <div>
                <p className="text-xs text-muted-foreground font-medium">Paper Balance</p>
                <p className="text-2xl font-semibold mt-1 font-mono tracking-tight">
                  ${paperBalance.toFixed(2)}
                </p>
                <p className="text-[11px] text-muted-foreground mt-0.5">started at $1,000</p>
              </div>
              <div className="w-8 h-8 rounded-md bg-primary/10 flex items-center justify-center">
                <DollarSign className="w-4 h-4 text-primary" />
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Total P&L */}
        <Card>
          <CardContent className="pt-5 pb-4 px-5">
            <div className="flex items-start justify-between">
              <div>
                <p className="text-xs text-muted-foreground font-medium">Total P&amp;L</p>
                <p className={cn(
                  "text-2xl font-semibold mt-1 font-mono tracking-tight",
                  totalPnl > 0 ? "text-profit" : totalPnl < 0 ? "text-loss" : ""
                )}>
                  {totalPnl >= 0 ? "+" : ""}{totalPnl.toFixed(2)}
                </p>
                <p className="text-[11px] text-muted-foreground mt-0.5">
                  {((paperBalance - startBalance) / startBalance * 100).toFixed(1)}% return
                </p>
              </div>
              <div className={cn(
                "w-8 h-8 rounded-md flex items-center justify-center",
                totalPnl >= 0 ? "bg-profit/10" : "bg-loss/10"
              )}>
                {totalPnl >= 0
                  ? <Trophy className="w-4 h-4 text-profit" />
                  : <TrendingDown className="w-4 h-4 text-loss" />}
              </div>
            </div>
          </CardContent>
        </Card>

        <StatCard
          title="Active Strategies"
          value={status?.activeStrategies ?? 0}
          subtitle={`of ${status?.totalStrategies ?? 0} total`}
          icon={Bot}
        />
        <StatCard
          title="Total Executions"
          value={totalExecutions}
          subtitle="all time"
          icon={Activity}
        />
      </div>

      {/* Engine Monitor */}
      <Card className="border-primary/20">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Radar className="w-4 h-4 text-primary" />
              <CardTitle className="text-sm font-medium">Engine Monitor</CardTitle>
            </div>
            <Badge variant={engine?.running ? "secondary" : "outline"} className="gap-1.5">
              <span className={cn(
                "w-1.5 h-1.5 rounded-full",
                engine?.running ? "bg-green-400 animate-pulse" : "bg-muted-foreground"
              )} />
              {engine?.running ? "Scanning" : "Stopped"}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
            <MonitorStat
              icon={TimerReset}
              label="Last Poll"
              value={engine?.lastPollAt ? new Date(engine.lastPollAt).toLocaleTimeString() : "—"}
              detail={engine?.lastPollOutcome || "No heartbeat yet"}
            />
            <MonitorStat
              icon={Zap}
              label="Manager Choice"
              value={engine?.managerDecision?.chosenStrategyName || "Stand down"}
              detail={engine?.managerDecision?.reason || "No manager decision yet"}
            />
            <MonitorStat
              icon={Bot}
              label="Open Paper Trades"
              value={String(engine?.openTrades ?? status?.openTrades ?? 0)}
              detail={`${engine?.activeStrategies ?? status?.activeStrategies ?? 0} active strategies`}
            />
            <MonitorStat
              icon={CircleDot}
              label="Poll Interval"
              value={engine?.pollingIntervalSec != null ? `${engine.pollingIntervalSec}s` : "—"}
              detail={engine?.circuitBreaker === "triggered" ? "Circuit breaker active" : "Paper engine ready"}
            />
          </div>

          <div className="rounded-lg border border-border/60 bg-muted/20 p-4 space-y-3">
            <div className="rounded-lg border border-border/60 bg-background/70 p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-xs text-muted-foreground">Manager Agent</p>
                  <p className="text-sm font-medium mt-1">
                    {engine?.managerDecision?.action === "enter_trade"
                      ? `Deploy ${engine.managerDecision.chosenStrategyName}`
                      : "Stand down"}
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">
                    {engine?.managerDecision?.reason || "No manager decision yet"}
                  </p>
                </div>
                <div className="text-right shrink-0">
                  <Badge variant={engine?.managerDecision?.action === "enter_trade" ? "default" : "secondary"}>
                    {engine?.managerDecision?.action?.replace(/_/g, " ") || "idle"}
                  </Badge>
                  <p className="text-[11px] text-muted-foreground mt-2 font-mono">
                    Score {engine?.managerDecision?.score != null ? engine.managerDecision.score.toFixed(2) : "—"}
                  </p>
                  <p className="text-[11px] text-muted-foreground font-mono">
                    Side {engine?.managerDecision?.side || "—"}
                  </p>
                </div>
              </div>
            </div>

            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-xs text-muted-foreground">Current BTC 5-minute market</p>
                <p className="text-sm font-medium mt-1">
                  {engine?.currentMarketQuestion || "Waiting for current BTC market"}
                </p>
                <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-xs text-muted-foreground font-mono">
                  <span>Market: {engine?.currentMarketId ? engine.currentMarketId.slice(0, 12) + "..." : "—"}</span>
                  <span>Condition: {engine?.currentConditionId ? engine.currentConditionId.slice(0, 12) + "..." : "—"}</span>
                </div>
              </div>
              <div className="text-right shrink-0">
                <p className="text-xs text-muted-foreground">Time left</p>
                <p className={cn(
                  "text-lg font-semibold font-mono mt-1",
                  secondsToExpiry == null ? "text-muted-foreground"
                    : secondsToExpiry <= 30 ? "text-loss"
                    : secondsToExpiry <= 90 ? "text-yellow-400"
                    : "text-profit"
                )}>
                  {secondsToExpiry == null ? "—" : `${secondsToExpiry}s`}
                </p>
              </div>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
              <div className="rounded-md bg-background/70 p-3">
                <p className="text-xs text-muted-foreground">YES Mid</p>
                <p className="font-mono font-medium mt-1">
                  {engine?.currentYesPrice != null ? `${(engine.currentYesPrice * 100).toFixed(1)}%` : "—"}
                </p>
              </div>
              <div className="rounded-md bg-background/70 p-3">
                <p className="text-xs text-muted-foreground">NO Mid</p>
                <p className="font-mono font-medium mt-1">
                  {engine?.currentNoPrice != null ? `${(engine.currentNoPrice * 100).toFixed(1)}%` : "—"}
                </p>
              </div>
              <div className="rounded-md bg-background/70 p-3">
                <p className="text-xs text-muted-foreground">Last Signal Time</p>
                <p className="font-mono font-medium mt-1">
                  {engine?.lastSignalAt ? new Date(engine.lastSignalAt).toLocaleTimeString() : "—"}
                </p>
              </div>
              <div className="rounded-md bg-background/70 p-3">
                <p className="text-xs text-muted-foreground">Last Poll Outcome</p>
                <p className="font-mono font-medium mt-1 text-[12px] break-words">
                  {engine?.lastPollOutcome || "—"}
                </p>
              </div>
            </div>

            {(engine?.marketDebug?.btcCandidateTitles?.length || engine?.marketDebug?.matchedEventTitles?.length) ? (
              <div className="rounded-md bg-background/70 p-3">
                <p className="text-xs text-muted-foreground mb-2">BTC Market Discovery Debug</p>
                <div className="space-y-2">
                  <div>
                    <p className="text-[11px] font-medium text-muted-foreground">Selector decision</p>
                    <div className="mt-1 space-y-1 text-xs font-mono">
                      <p>Target: {engine?.marketDebug?.selectorTarget || "—"}</p>
                      <p>Winner: {engine?.marketDebug?.selectorWinner || "—"}</p>
                    </div>
                    {engine?.marketDebug?.selectorCandidates?.length ? (
                      <ul className="mt-1 space-y-1 text-xs">
                        {engine.marketDebug.selectorCandidates.map((title, index) => (
                          <li key={`selector-${index}`} className="font-mono break-words">{title}</li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                  <div>
                    <p className="text-[11px] font-medium text-muted-foreground">Matched rolling titles</p>
                    {engine?.marketDebug?.matchedEventTitles?.length ? (
                      <ul className="mt-1 space-y-1 text-xs">
                        {engine.marketDebug.matchedEventTitles.map((title, index) => (
                          <li key={`matched-${index}`} className="font-mono break-words">{title}</li>
                        ))}
                      </ul>
                    ) : (
                      <p className="text-xs text-muted-foreground mt-1">No exact rolling-title matches yet</p>
                    )}
                  </div>
                  <div>
                    <p className="text-[11px] font-medium text-muted-foreground">BTC-related titles seen</p>
                    {engine?.marketDebug?.btcCandidateTitles?.length ? (
                      <ul className="mt-1 space-y-1 text-xs">
                        {engine.marketDebug.btcCandidateTitles.map((title, index) => (
                          <li key={`candidate-${index}`} className="font-mono break-words">{title}</li>
                        ))}
                      </ul>
                    ) : (
                      <p className="text-xs text-muted-foreground mt-1">No BTC-like event titles returned</p>
                    )}
                  </div>
                </div>
              </div>
            ) : null}
          </div>

          <div className="rounded-lg border border-border/60 bg-muted/20 p-4">
            <div className="flex items-center justify-between gap-3 mb-3">
              <p className="text-sm font-medium">Per-Strategy Diagnostics</p>
              <p className="text-[11px] text-muted-foreground">
                {engine?.strategyDiagnostics?.[0]?.checkedAt
                  ? `Updated ${new Date(engine.strategyDiagnostics[0].checkedAt).toLocaleTimeString()}`
                  : "No scan yet"}
              </p>
            </div>

            {!engine?.strategyDiagnostics || engine.strategyDiagnostics.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Enable a strategy to see per-candle diagnostics here.
              </p>
            ) : (
              <div className="space-y-2">
                {engine.strategyDiagnostics.map((item) => (
                  <div
                    key={item.strategyId}
                    className="flex items-start justify-between gap-3 rounded-md bg-background/70 px-3 py-2.5"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-medium">{item.strategyName}</p>
                      <p className="text-xs text-muted-foreground mt-1">{item.detail}</p>
                      <p className="text-[11px] text-muted-foreground mt-1 font-mono">
                        Score {item.score != null ? item.score.toFixed(2) : "—"}
                      </p>
                    </div>
                    <Badge
                      variant={diagnosticVariant(item.outcome)}
                      className="shrink-0 text-[10px] uppercase tracking-wide"
                    >
                      {item.outcome.replace(/_/g, " ")}
                    </Badge>
                  </div>
                ))}
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Safeguards */}
      <Card className={cn(
        safeguards?.circuitBreaker === "triggered" && "border-destructive/50 bg-destructive/5"
      )}>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              {safeguards?.circuitBreaker === "triggered"
                ? <ShieldAlert className="w-4 h-4 text-destructive" />
                : <ShieldCheck className="w-4 h-4 text-profit" />}
              <CardTitle className="text-sm font-medium">Safeguards</CardTitle>
            </div>
            {safeguards?.circuitBreaker === "triggered" && (
              <Badge variant="destructive" className="text-[10px]">Circuit Breaker Triggered</Badge>
            )}
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            {/* Drawdown */}
            <div>
              <p className="text-xs text-muted-foreground">Daily Drawdown</p>
              <p className={cn(
                "text-lg font-semibold font-mono mt-0.5",
                (safeguards?.drawdownPct ?? 0) >= (safeguards?.drawdownLimit ?? 10)
                  ? "text-destructive" : (safeguards?.drawdownPct ?? 0) > (safeguards?.drawdownLimit ?? 10) * 0.7
                  ? "text-yellow-400" : "text-profit"
              )}>
                {safeguards?.drawdownPct?.toFixed(1) ?? "0.0"}%
              </p>
              <p className="text-[11px] text-muted-foreground">limit {safeguards?.drawdownLimit ?? 10}%</p>
            </div>
            {/* Latency */}
            <div>
              <p className="text-xs text-muted-foreground flex items-center gap-1"><Wifi className="w-3 h-3" /> Latency</p>
              <p className={cn(
                "text-lg font-semibold font-mono mt-0.5",
                safeguards?.latencyMs == null ? "text-muted-foreground"
                  : safeguards.latencyMs < 300 ? "text-profit"
                  : safeguards.latencyMs < 800 ? "text-yellow-400" : "text-loss"
              )}>
                {safeguards?.latencyMs != null ? `${safeguards.latencyMs}ms` : "—"}
              </p>
              <p className="text-[11px] text-muted-foreground">to Gamma API</p>
            </div>
            {/* Lag Score */}
            <div>
              <p className="text-xs text-muted-foreground flex items-center gap-1"><Zap className="w-3 h-3" /> Lag Score</p>
              <p className={cn(
                "text-lg font-semibold font-mono mt-0.5",
                safeguards?.lagScore == null ? "text-muted-foreground"
                  : safeguards.lagScore > 0.6 ? "text-profit"
                  : safeguards.lagScore > 0.3 ? "text-yellow-400" : "text-muted-foreground"
              )}>
                {safeguards?.lagScore != null ? safeguards.lagScore.toFixed(2) : "—"}
              </p>
              <p className="text-[11px] text-muted-foreground">0=neutral · 1=strong signal</p>
            </div>
            {/* BTC spot vs Poly */}
            <div>
              <p className="text-xs text-muted-foreground">BTC Prices</p>
              <div className="mt-0.5 space-y-0.5">
                <p className="text-xs font-mono">
                  <span className="text-muted-foreground">Spot: </span>
                  <span className="font-medium">
                    {safeguards?.chainlinkPrice ? `$${safeguards.chainlinkPrice.toLocaleString()}` : "—"}
                  </span>
                </p>
                <p className="text-xs font-mono">
                  <span className="text-muted-foreground">Up prob: </span>
                  <span className="font-medium">
                    {safeguards?.polyPrice != null ? `${(safeguards.polyPrice * 100).toFixed(0)}%` : "—"}
                  </span>
                </p>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Active Strategies */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium">Active Strategies</CardTitle>
        </CardHeader>
        <CardContent>
          {activeStrats.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">
              No active strategies. Enable one in the Strategies tab.
            </p>
          ) : (
            <div className="space-y-2">
              {activeStrats.map((s) => (
                <div
                  key={s.id}
                  className="flex items-center justify-between py-2.5 px-3 rounded-md bg-muted/40"
                  data-testid={`strategy-row-${s.id}`}
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium truncate">{s.name}</p>
                    <p className="text-xs text-muted-foreground truncate">
                      {s.marketQuestion || "No market selected"}
                    </p>
                  </div>
                  <div className="text-right ml-4 shrink-0">
                    <Badge variant="outline" className="text-xs">
                      {s.side} @ {s.triggerType === "price_below" ? "<" : ">"} {(s.triggerPrice * 100).toFixed(0)}%
                    </Badge>
                    <p className="text-[11px] text-muted-foreground mt-1">
                      {s.totalExecutions} runs
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Strategy Activity */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium">Strategy Activity</CardTitle>
        </CardHeader>
        <CardContent>
          {recentTrades.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">
              Strategy entries will appear here once the manager opens paper trades.
            </p>
          ) : (
            <div className="space-y-2">
              {recentTrades.slice(0, 8).map((t) => (
                <div
                  key={`activity-${t.id}`}
                  className="rounded-md border border-border/60 bg-muted/20 px-3 py-2.5"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-sm font-medium">
                          {t.strategyName || `Strategy ${t.strategyId ?? "unknown"}`}
                        </p>
                        <Badge variant="outline" className="text-[10px]">
                          {t.side} {t.outcome}
                        </Badge>
                        <StatusBadge status={t.status} />
                      </div>
                      <p className="text-xs text-muted-foreground mt-1 break-words">
                        {t.errorMessage || "Paper trade opened by manager"}
                      </p>
                      <p className="text-[11px] text-muted-foreground mt-1 font-mono truncate">
                        {t.marketQuestion || t.tokenId.slice(0, 16) + "..."}
                      </p>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-xs font-mono">
                        {new Date(t.timestamp).toLocaleTimeString()}
                      </p>
                      <p className="text-xs font-mono mt-1">
                        {(t.price * 100).toFixed(1)}% / ${t.size.toFixed(2)}
                      </p>
                      {t.netPnl != null ? (
                        <p className={cn(
                          "text-xs font-mono mt-1",
                          t.netPnl >= 0 ? "text-profit" : "text-loss",
                        )}>
                          {t.netPnl >= 0 ? "+" : ""}{t.netPnl.toFixed(2)}
                        </p>
                      ) : null}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Recent Trade Log */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium">Recent Trades</CardTitle>
        </CardHeader>
        <CardContent>
          {recentTrades.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">
              No trades logged yet. Simulate a strategy to see results here.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-muted-foreground text-xs">
                    <th className="text-left py-2 font-medium">Time</th>
                    <th className="text-left py-2 font-medium">Market</th>
                    <th className="text-left py-2 font-medium">Side</th>
                    <th className="text-right py-2 font-medium">Price</th>
                    <th className="text-right py-2 font-medium">Size</th>
                    <th className="text-right py-2 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {recentTrades.map((t) => (
                    <tr key={t.id} className="border-b border-border/50 last:border-0" data-testid={`trade-row-${t.id}`}>
                      <td className="py-2 text-xs text-muted-foreground font-mono">
                        {new Date(t.timestamp).toLocaleTimeString()}
                      </td>
                      <td className="py-2 max-w-[200px] truncate">
                        {t.marketQuestion || t.tokenId.slice(0, 12) + "..."}
                      </td>
                      <td className="py-2">
                        <Badge variant="outline" className="text-[11px]">
                          {t.side} {t.outcome}
                        </Badge>
                      </td>
                      <td className="py-2 text-right font-mono">
                        {(t.price * 100).toFixed(1)}%
                      </td>
                      <td className="py-2 text-right font-mono">
                        ${t.size.toFixed(2)}
                      </td>
                      <td className="py-2 text-right">
                        <StatusBadge status={t.status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function StatCard({
  title,
  value,
  subtitle,
  icon: Icon,
}: {
  title: string;
  value: string | number;
  subtitle: string;
  icon: any;
}) {
  return (
    <Card>
      <CardContent className="pt-5 pb-4 px-5">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-xs text-muted-foreground font-medium">{title}</p>
            <p className="text-2xl font-semibold mt-1 font-mono tracking-tight">{value}</p>
            <p className="text-[11px] text-muted-foreground mt-0.5">{subtitle}</p>
          </div>
          <div className="w-8 h-8 rounded-md bg-primary/10 flex items-center justify-center">
            <Icon className="w-4 h-4 text-primary" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function MonitorStat({
  icon: Icon,
  label,
  value,
  detail,
}: {
  icon: typeof Bot;
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="rounded-lg border border-border/60 bg-muted/20 p-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-xs text-muted-foreground">{label}</p>
          <p className="text-sm font-semibold mt-1">{value}</p>
          <p className="text-[11px] text-muted-foreground mt-1">{detail}</p>
        </div>
        <div className="w-8 h-8 rounded-md bg-primary/10 flex items-center justify-center shrink-0">
          <Icon className="w-4 h-4 text-primary" />
        </div>
      </div>
    </div>
  );
}

function diagnosticVariant(outcome: string): "default" | "secondary" | "destructive" | "outline" {
  if (outcome === "entered") return "default";
  if (outcome === "error") return "destructive";
  if (outcome === "no_signal" || outcome === "pending_scan") return "outline";
  return "secondary";
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    filled: "bg-profit text-profit",
    simulated: "bg-primary/10 text-primary",
    failed: "bg-loss text-loss",
    pending: "bg-muted text-muted-foreground",
    not_triggered: "bg-muted text-muted-foreground",
  };
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-medium ${colors[status] || colors.pending}`}>
      {status.replace("_", " ")}
    </span>
  );
}
