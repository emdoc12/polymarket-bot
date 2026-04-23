import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { TradeLog } from "@shared/schema";

export default function Trades() {
  const { data: trades, isLoading } = useQuery<TradeLog[]>({
    queryKey: ["/api/trades"],
  });

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
          {!trades || trades.length === 0 ? (
            <div className="py-12 text-center">
              <p className="text-sm text-muted-foreground">
                No trades logged yet.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
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
                  {trades.map((t) => (
                    <tr
                      key={t.id}
                      className="border-b border-border/50 last:border-0 hover:bg-muted/20 transition-colors"
                      data-testid={`trade-log-row-${t.id}`}
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
                          {t.side} {t.outcome}
                        </Badge>
                      </td>
                      <td className="py-2.5 px-4 text-right font-mono text-sm">
                        {(t.price * 100).toFixed(1)}%
                      </td>
                      <td className="py-2.5 px-4 text-right font-mono text-sm">
                        ${t.size.toFixed(2)}
                      </td>
                      <td className="py-2.5 px-4 text-right">
                        <StatusBadge status={t.status} />
                      </td>
                      <td className="py-2.5 px-4 text-xs text-muted-foreground">
                        {t.strategyId ? `#${t.strategyId}` : "—"}
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
