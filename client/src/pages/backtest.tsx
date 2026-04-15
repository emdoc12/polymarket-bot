import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import {
  FlaskConical, TrendingUp, TrendingDown, Trophy,
  CheckCircle2, XCircle, Play, RefreshCw,
} from "lucide-react";
import type { BacktestRun } from "@shared/schema";

const STRATEGY_NAMES = [
  "Last-Second Momentum Snipe",
  "Orderbook Arbitrage & Imbalance",
  "Spot Correlation Reversion Scalp",
  "Oracle Lead Arbitrage",
];

export default function Backtest() {
  const { toast } = useToast();
  const [strategyName, setStrategyName] = useState(STRATEGY_NAMES[0]);
  const [periodDays, setPeriodDays] = useState("7");
  const [orderSize, setOrderSize] = useState("10");

  const { data: runs, isLoading: runsLoading } = useQuery<BacktestRun[]>({
    queryKey: ["/api/backtest"],
    refetchInterval: false,
  });

  const runMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/backtest", {
        strategyName,
        periodDays: parseInt(periodDays),
        orderSize: parseFloat(orderSize),
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/backtest"] });
      toast({ title: "Backtest complete" });
    },
    onError: (e: Error) => {
      toast({ title: "Backtest failed", description: e.message, variant: "destructive" });
    },
  });

  const latestByStrategy: Record<string, BacktestRun> = {};
  (runs || []).forEach((r) => {
    if (!latestByStrategy[r.strategyName]) latestByStrategy[r.strategyName] = r;
  });

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold tracking-tight">Backtest</h2>
        <p className="text-sm text-muted-foreground mt-0.5">
          Simulate each strategy against real Chainlink BTC/USD 5-min OHLC data. Target: 65%+ win rate, 3%+ net edge after fees.
        </p>
      </div>

      {/* Run config */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <FlaskConical className="w-4 h-4 text-primary" />
            <CardTitle className="text-sm font-medium">Run Backtest</CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-4 items-end">
            <div className="space-y-1.5">
              <Label className="text-xs">Strategy</Label>
              <Select value={strategyName} onValueChange={setStrategyName}>
                <SelectTrigger className="w-64">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {STRATEGY_NAMES.map((n) => (
                    <SelectItem key={n} value={n}>{n}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Period (days)</Label>
              <Select value={periodDays} onValueChange={setPeriodDays}>
                <SelectTrigger className="w-28">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {["1", "3", "7", "14", "30"].map((d) => (
                    <SelectItem key={d} value={d}>{d}d</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Order size (USDC)</Label>
              <Input
                type="number"
                min="1"
                value={orderSize}
                onChange={(e) => setOrderSize(e.target.value)}
                className="w-24 font-mono"
              />
            </div>
            <Button
              onClick={() => runMutation.mutate()}
              disabled={runMutation.isPending}
              className="gap-1.5"
            >
              {runMutation.isPending
                ? <><RefreshCw className="w-3.5 h-3.5 animate-spin" /> Running…</>
                : <><Play className="w-3.5 h-3.5" /> Run</>}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Summary cards per strategy */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {STRATEGY_NAMES.map((name) => {
          const r = latestByStrategy[name];
          return (
            <Card key={name} className={cn(r?.meetsTarget && "border-profit/40 bg-profit/[0.03]")}>
              <CardContent className="py-4 px-5">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-xs font-semibold truncate">{name}</p>
                    {r ? (
                      <div className="mt-2 space-y-1.5">
                        <div className="flex items-center gap-3 flex-wrap">
                          <span className={cn(
                            "text-lg font-semibold font-mono",
                            r.winRate >= 0.65 ? "text-profit" : "text-loss"
                          )}>
                            {(r.winRate * 100).toFixed(1)}% win
                          </span>
                          <span className={cn(
                            "text-sm font-mono font-medium",
                            r.netPnl >= 0 ? "text-profit" : "text-loss"
                          )}>
                            {r.netPnl >= 0 ? "+" : ""}{r.netPnl.toFixed(2)} net
                          </span>
                        </div>
                        <div className="flex items-center gap-3 text-xs text-muted-foreground flex-wrap">
                          <span>{r.totalTrades} trades · {r.wins}W/{r.losses}L</span>
                          <span>Edge: {r.edgePct.toFixed(1)}%</span>
                          <span>Fees: ${r.totalFees.toFixed(2)}</span>
                          <span>{r.periodDays}d · {new Date(r.ranAt).toLocaleDateString()}</span>
                        </div>
                      </div>
                    ) : (
                      <p className="text-xs text-muted-foreground mt-2">No backtest run yet</p>
                    )}
                  </div>
                  <div className="shrink-0 mt-0.5">
                    {r ? (
                      r.meetsTarget
                        ? <CheckCircle2 className="w-5 h-5 text-profit" />
                        : <XCircle className="w-5 h-5 text-loss" />
                    ) : (
                      <div className="w-5 h-5 rounded-full border-2 border-muted" />
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Full run history */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium">Run History</CardTitle>
        </CardHeader>
        <CardContent>
          {runsLoading ? (
            <div className="space-y-2">
              {[1, 2, 3].map((i) => <Skeleton key={i} className="h-10 w-full" />)}
            </div>
          ) : !runs || runs.length === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center">
              No backtest runs yet. Run one above to see results.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b text-muted-foreground">
                    <th className="text-left py-2 font-medium">Strategy</th>
                    <th className="text-right py-2 font-medium">Period</th>
                    <th className="text-right py-2 font-medium">Trades</th>
                    <th className="text-right py-2 font-medium">Win %</th>
                    <th className="text-right py-2 font-medium">Edge %</th>
                    <th className="text-right py-2 font-medium">Net P&L</th>
                    <th className="text-right py-2 font-medium">Target</th>
                    <th className="text-right py-2 font-medium">Date</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map((r) => (
                    <tr key={r.id} className="border-b border-border/50 last:border-0">
                      <td className="py-2 max-w-[160px] truncate font-medium">{r.strategyName}</td>
                      <td className="py-2 text-right text-muted-foreground">{r.periodDays}d</td>
                      <td className="py-2 text-right font-mono">{r.totalTrades}</td>
                      <td className={cn("py-2 text-right font-mono font-medium", r.winRate >= 0.65 ? "text-profit" : "text-loss")}>
                        {(r.winRate * 100).toFixed(1)}%
                      </td>
                      <td className={cn("py-2 text-right font-mono", r.edgePct >= 3 ? "text-profit" : "text-loss")}>
                        {r.edgePct.toFixed(1)}%
                      </td>
                      <td className={cn("py-2 text-right font-mono", r.netPnl >= 0 ? "text-profit" : "text-loss")}>
                        {r.netPnl >= 0 ? "+" : ""}{r.netPnl.toFixed(2)}
                      </td>
                      <td className="py-2 text-right">
                        {r.meetsTarget
                          ? <CheckCircle2 className="w-3.5 h-3.5 text-profit inline" />
                          : <XCircle className="w-3.5 h-3.5 text-loss inline" />}
                      </td>
                      <td className="py-2 text-right text-muted-foreground">
                        {new Date(r.ranAt).toLocaleDateString()}
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
