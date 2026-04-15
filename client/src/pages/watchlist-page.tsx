import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Trash2, RefreshCw } from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { Watchlist } from "@shared/schema";
import { useState } from "react";

export default function WatchlistPage() {
  const { toast } = useToast();
  const [prices, setPrices] = useState<Record<string, number>>({});

  const { data: items, isLoading } = useQuery<Watchlist[]>({
    queryKey: ["/api/watchlist"],
  });

  const removeMutation = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/watchlist/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/watchlist"] });
      toast({ title: "Removed from watchlist" });
    },
  });

  const refreshPrices = async () => {
    if (!items) return;
    const newPrices: Record<string, number> = {};
    for (const item of items) {
      try {
        const res = await fetch(`/api/midpoint/${item.tokenId}`);
        if (res.ok) {
          const data = await res.json();
          newPrices[item.tokenId] = parseFloat(data.mid || "0");
        }
      } catch {}
    }
    setPrices(newPrices);
    toast({ title: "Prices refreshed" });
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">Watchlist</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            Markets you're tracking
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={refreshPrices}
          disabled={!items || items.length === 0}
          data-testid="button-refresh-prices"
        >
          <RefreshCw className="w-3.5 h-3.5 mr-1.5" />
          Refresh Prices
        </Button>
      </div>

      {!items || items.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <p className="text-sm text-muted-foreground">
              Your watchlist is empty. Browse Markets to add items.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {items.map((item) => (
            <Card key={item.id} data-testid={`watchlist-item-${item.id}`}>
              <CardContent className="py-3.5 px-4">
                <div className="flex items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{item.marketQuestion}</p>
                    <div className="flex items-center gap-3 mt-1">
                      <span className="text-xs text-muted-foreground font-mono">
                        {item.conditionId.slice(0, 16)}...
                      </span>
                      <span className="text-xs text-muted-foreground">
                        Added {new Date(item.addedAt).toLocaleDateString()}
                      </span>
                    </div>
                  </div>
                  <div className="text-right shrink-0 mr-2">
                    {prices[item.tokenId] !== undefined ? (
                      <span className="text-lg font-semibold font-mono">
                        {(prices[item.tokenId] * 100).toFixed(1)}%
                      </span>
                    ) : (
                      <span className="text-sm text-muted-foreground">—</span>
                    )}
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-destructive shrink-0"
                    onClick={() => removeMutation.mutate(item.id)}
                    data-testid={`button-remove-${item.id}`}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
