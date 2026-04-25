import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { TradeLog } from "@shared/schema";

type DisplayTrade = {
  key: string;
  timestamp: string;
  marketQuestion: string | null;
  tokenId: string;
  action: string;
  priceLabel: string;
  size: number;
  status: string;
  strategyName: string | null;
  strategyId: number | null;
  netPnl: number | null;
  ids: number[];
};

function groupTradesForDisplay(trades: TradeLog[]): DisplayTrade[] {
  const grouped = new Map<string, TradeLog[]>();
  const singles: TradeLog[] = [];
  for (const trade of trades) {
    if (trade.tradeGroupId) {
      const legs = grouped.get(trade.tradeGroupId) ?? [];
      legs.push(trade);
      grouped.set(trade.tradeGroupId, legs);
    } else {
      singles.push(trade);
    }
  }

  const groupedItems = Array.from(grouped.entries()).map(([tradeGroupId, legs]) => {
    const first = legs[0];
    const totalSize = legs.reduce((sum, leg) => sum + leg.size, 0);
    const netPnl = legs.every((leg) => leg.netPnl != null)
      ? legs.reduce((sum, leg) => sum + (leg.netPnl ?? 0), 0)
      : null;
    const status = legs.some((leg) => leg.status === "open") ? "open" : first.status;
    const avgPrice = totalSize > 0
      ? legs.reduce((sum, leg) => sum + leg.price * leg.size, 0) / totalSize
      : first.price;
    return {
      key: tradeGroupId,
      timestamp: first.timestamp,
      marketQuestion: first.marketQuestion,
      tokenId: first.tokenId,
      action: "BUY YES+NO",
      priceLabel: `pair avg ${(avgPrice * 100).toFixed(1)}%`,
      size: totalSize,
      status,
      strategyName: first.strategyName,
      strategyId: first.strategyId,
      netPnl,
      ids: legs.map((leg) => leg.id),
    };
  });

  const singleItems = singles.map((trade) => ({
    key: String(trade.id),
    timestamp: trade.timestamp,
    marketQuestion: trade.marketQuestion,
    tokenId: trade.tokenId,
    action: `${trade.side} ${trade.outcome}`,
    priceLabel: `${(trade.price * 100).toFixed(1)}%`,
    size: trade.size,
    status: trade.status,
    strategyName: trade.strategyName,
    strategyId: trade.strategyId,
    netPnl: trade.netPnl,
    ids: [trade.id],
  }));

  return [...groupedItems, ...singleItems].sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
  );
}

export default function Trades() {
  const { data: trades } = useQuery<TradeLog[]>({
    queryKey: ["/api/trades"],
  });
  const displayTrades = groupTradesForDisplay(trades ?? []);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold tracking-tight">Trade Log</h2>
        <p className="text-sm text-muted-foreground mt-0.5">
          Rolling BTC 5-minute paper positions and their settlement history
        </p>
      </div>

      <Card>
        <CardContent className="p-0">
          {displayTrades.length === 0 ? (
            <div className="py-12 text-center">
              <p className="text-sm text-muted-foreground">
                No trades logged yet.
              </p>
            </div>
          ) : (
            <>
            <div className="space-y-2 p-3 sm:hidden">
              {displayTrades.map((t) => (
                <div
                  key={`trade-card-${t.key}`}
                  className="rounded-md border border-border/60 bg-muted/20 p-3"
                  data-testid={`trade-log-card-${t.key}`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate">
                        {t.marketQuestion || t.tokenId.slice(0, 16) + "..."}
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground font-mono">
                        {new Date(t.timestamp).toLocaleString()}
                      </p>
                    </div>
                    <StatusBadge status={t.status} />
                  </div>
                  <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
                    <div>
                      <p className="text-muted-foreground">Action</p>
                      <p className="font-mono">{t.action}</p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">Price</p>
                      <p className="font-mono">{t.priceLabel}</p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">Size</p>
                      <p className="font-mono">${t.size.toFixed(2)}</p>
                    </div>
                  </div>
                  <div className="mt-3 flex items-center justify-between gap-3 text-xs">
                    <span className="text-muted-foreground">{t.strategyName || (t.strategyId ? `#${t.strategyId}` : "—")}</span>
                    {t.netPnl != null ? (
                      <span className={t.netPnl >= 0 ? "text-profit font-mono" : "text-loss font-mono"}>
                        {t.netPnl >= 0 ? "+" : ""}{t.netPnl.toFixed(2)}
                      </span>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
            <div className="hidden overflow-x-auto sm:block">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/30">
                    <th className="text-left py-2.5 px-4 text-xs font-medium text-muted-foreground">Time</th>
                    <th className="text-left py-2.5 px-4 text-xs font-medium text-muted-foreground">Market</th>
                    <th className="text-left py-2.5 px-4 text-xs font-medium text-muted-foreground">Action</th>
                    <th className="text-right py-2.5 px-4 text-xs font-medium text-muted-foreground">Price</th>
                    <th className="text-right py-2.5 px-4 text-xs font-medium text-muted-foreground">Size</th>
                    <th className="text-right py-2.5 px-4 text-xs font-medium text-muted-foreground">Status</th>
                    <th className="text-left py-2.5 px-4 text-xs font-medium text-muted-foreground">Strategy</th>
                  </tr>
                </thead>
                <tbody>
                  {displayTrades.map((t) => (
                    <tr
                      key={t.key}
                      className="border-b border-border/50 last:border-0 hover:bg-muted/20 transition-colors"
                      data-testid={`trade-log-row-${t.key}`}
                    >
                      <td className="py-2.5 px-4 text-xs text-muted-foreground font-mono whitespace-nowrap">
                        {new Date(t.timestamp).toLocaleString()}
                      </td>
                      <td className="py-2.5 px-4 max-w-[250px]">
                        <p className="text-sm truncate">
                          {t.marketQuestion || t.tokenId.slice(0, 16) + "..."}
                        </p>
                      </td>
                      <td className="py-2.5 px-4">
                        <Badge variant="outline" className="text-[11px] font-mono">
                          {t.action}
                        </Badge>
                      </td>
                      <td className="py-2.5 px-4 text-right font-mono text-sm">
                        {t.priceLabel}
                      </td>
                      <td className="py-2.5 px-4 text-right font-mono text-sm">
                        ${t.size.toFixed(2)}
                      </td>
                      <td className="py-2.5 px-4 text-right">
                        <StatusBadge status={t.status} />
                      </td>
                      <td className="py-2.5 px-4 text-xs text-muted-foreground">
                        {t.strategyName || (t.strategyId ? `#${t.strategyId}` : "—")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const variants: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
    open: "secondary",
    closed: "default",
    pending_resolution: "outline",
    filled: "default",
    simulated: "outline",
    failed: "destructive",
    pending: "secondary",
    not_triggered: "secondary",
  };
  return (
    <Badge variant={variants[status] || "secondary"} className="text-[11px]">
      {status.replace("_", " ")}
    </Badge>
  );
}
