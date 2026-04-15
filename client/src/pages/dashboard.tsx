import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Bot, Activity, DollarSign, Trophy, TrendingDown } from "lucide-react";
import { cn } from "@/lib/utils";
import type { TradeLog, Strategy } from "@shared/schema";

export default function Dashboard() {
  const { data: status } = useQuery<{
    mode: string;
    activeStrategies: number;
    totalStrategies: number;
    recentTrades: TradeLog[];
  }>({ queryKey: ["/api/bot/status"], refetchInterval: 10000 });

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

  const activeStrats = strategies?.filter((s) => s.isActive) || [];
  const recentTrades = status?.recentTrades || [];
  const totalExecutions = strategies?.reduce((sum, s) => sum + s.totalExecutions, 0) || 0;
  const paperBalance = pnl?.paperBalance ?? 1000;
  const totalPnl = pnl?.totalPnl ?? 0;
  const startBalance = 1000;

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

      {/* Active Strategies */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium">Active Strategies</CardTitle>
        </CardHeader>
        <CardContent>
          {activeStrats.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">
              No active strategies. Create one in the Strategies tab.
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
