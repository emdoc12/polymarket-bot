import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Search, Star, TrendingUp, Eye } from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

interface PolyMarket {
  id: string;
  question: string;
  conditionId: string;
  slug: string;
  outcomePrices?: string;
  outcomes?: string;
  clobTokenIds?: string;
  volume?: string;
  volumeNum?: number;
  liquidity?: string;
  liquidityNum?: number;
  endDate?: string;
  image?: string;
  icon?: string;
  description?: string;
  active?: boolean;
  closed?: boolean;
}

export default function Markets() {
  const [searchQuery, setSearchQuery] = useState("");
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedMarket, setSelectedMarket] = useState<PolyMarket | null>(null);
  const { toast } = useToast();

  const { data: markets, isLoading } = useQuery<PolyMarket[]>({
    queryKey: ["/api/markets", searchTerm],
    queryFn: async () => {
      const params = new URLSearchParams({ limit: "30" });
      if (searchTerm) params.set("search", searchTerm);
      const res = await fetch(`${""}/api/markets?${params}`);
      if (!res.ok) throw new Error("Failed to fetch markets");
      const data = await res.json();
      // Search endpoint returns differently
      if (Array.isArray(data)) return data;
      if (data.markets) return data.markets;
      return [];
    },
    refetchInterval: 30000,
  });

  const addToWatchlist = useMutation({
    mutationFn: async (market: PolyMarket) => {
      const tokenIds = market.clobTokenIds ? JSON.parse(market.clobTokenIds) : [];
      await apiRequest("POST", "/api/watchlist", {
        conditionId: market.conditionId,
        tokenId: tokenIds[0] || "",
        marketQuestion: market.question,
        addedAt: new Date().toISOString(),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/watchlist"] });
      toast({ title: "Added to watchlist" });
    },
    onError: (e: Error) => {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    },
  });

  const handleSearch = () => {
    setSearchTerm(searchQuery);
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold tracking-tight">Markets</h2>
        <p className="text-sm text-muted-foreground mt-0.5">
          Browse and search Polymarket prediction markets
        </p>
      </div>

      {/* Search bar */}
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            data-testid="input-market-search"
            placeholder="Search markets..."
            className="pl-9"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSearch()}
          />
        </div>
        <Button onClick={handleSearch} data-testid="button-search">
          Search
        </Button>
      </div>

      {/* Market list */}
      {isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-20 w-full rounded-lg" />
          ))}
        </div>
      ) : !markets || markets.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <p className="text-sm text-muted-foreground">
              {searchTerm ? "No markets found for your search." : "No markets available."}
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {markets.map((market) => {
            const prices = market.outcomePrices
              ? JSON.parse(market.outcomePrices)
              : [];
            const outcomes = market.outcomes
              ? JSON.parse(market.outcomes)
              : ["Yes", "No"];
            const yesPrice = prices[0] ? parseFloat(prices[0]) : null;
            const volume = market.volumeNum || (market.volume ? parseFloat(market.volume) : 0);

            return (
              <Card
                key={market.id || market.conditionId}
                className="hover:bg-muted/30 transition-colors cursor-pointer"
                data-testid={`market-card-${market.conditionId}`}
              >
                <CardContent className="py-3.5 px-4">
                  <div className="flex items-start gap-3">
                    {market.image && (
                      <img
                        src={market.image}
                        alt=""
                        className="w-10 h-10 rounded-md object-cover shrink-0 mt-0.5"
                      />
                    )}
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium leading-snug">
                        {market.question}
                      </p>
                      <div className="flex items-center gap-3 mt-1.5">
                        {yesPrice !== null && (
                          <span className="text-xs font-mono">
                            <span className="text-muted-foreground">Yes: </span>
                            <span className="font-medium text-profit">
                              {(yesPrice * 100).toFixed(1)}%
                            </span>
                          </span>
                        )}
                        {volume > 0 && (
                          <span className="text-xs text-muted-foreground flex items-center gap-1">
                            <TrendingUp className="w-3 h-3" />
                            ${volume >= 1000000
                              ? (volume / 1000000).toFixed(1) + "M"
                              : volume >= 1000
                              ? (volume / 1000).toFixed(0) + "K"
                              : volume.toFixed(0)}
                          </span>
                        )}
                        {market.endDate && (
                          <span className="text-xs text-muted-foreground">
                            Ends {new Date(market.endDate).toLocaleDateString()}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        data-testid={`button-view-${market.conditionId}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          setSelectedMarket(market);
                        }}
                      >
                        <Eye className="w-3.5 h-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        data-testid={`button-watchlist-${market.conditionId}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          addToWatchlist.mutate(market);
                        }}
                      >
                        <Star className="w-3.5 h-3.5" />
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* Market Detail Dialog */}
      <MarketDetailDialog
        market={selectedMarket}
        onClose={() => setSelectedMarket(null)}
      />
    </div>
  );
}

function MarketDetailDialog({
  market,
  onClose,
}: {
  market: PolyMarket | null;
  onClose: () => void;
}) {
  if (!market) return null;

  const prices = market.outcomePrices ? JSON.parse(market.outcomePrices) : [];
  const outcomes = market.outcomes ? JSON.parse(market.outcomes) : ["Yes", "No"];
  const tokenIds = market.clobTokenIds ? JSON.parse(market.clobTokenIds) : [];

  return (
    <Dialog open={!!market} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-base leading-snug pr-6">
            {market.question}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4 mt-2">
          {market.description && (
            <p className="text-sm text-muted-foreground line-clamp-4">
              {market.description}
            </p>
          )}

          <div className="grid grid-cols-2 gap-3">
            {outcomes.map((outcome: string, i: number) => (
              <div
                key={i}
                className="rounded-lg border p-3 text-center"
                data-testid={`outcome-${outcome.toLowerCase()}`}
              >
                <p className="text-xs text-muted-foreground mb-1">{outcome}</p>
                <p className="text-lg font-semibold font-mono">
                  {prices[i]
                    ? (parseFloat(prices[i]) * 100).toFixed(1) + "%"
                    : "—"}
                </p>
              </div>
            ))}
          </div>

          <div className="text-xs text-muted-foreground space-y-1">
            <p>
              <span className="font-medium text-foreground">Condition ID:</span>{" "}
              <span className="font-mono">{market.conditionId?.slice(0, 20)}...</span>
            </p>
            {tokenIds[0] && (
              <p>
                <span className="font-medium text-foreground">Token ID (Yes):</span>{" "}
                <span className="font-mono">{tokenIds[0]?.slice(0, 20)}...</span>
              </p>
            )}
            {market.endDate && (
              <p>
                <span className="font-medium text-foreground">End Date:</span>{" "}
                {new Date(market.endDate).toLocaleString()}
              </p>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
