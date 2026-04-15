import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Search, Star, TrendingUp, Eye, CheckCircle2, Circle } from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

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
  _eventTitle?: string;
  _eventImage?: string;
}

interface Tag {
  id: number;
  label: string;
  slug: string;
}

const CATEGORY_TABS = [
  { label: "All", slug: "" },
  { label: "Crypto", slug: "crypto" },
  { label: "Bitcoin", slug: "bitcoin" },
  { label: "Sports", slug: "sports" },
  { label: "Politics", slug: "politics" },
  { label: "Finance", slug: "finance" },
  { label: "Tech", slug: "technology" },
  { label: "Culture", slug: "culture" },
  { label: "Elections", slug: "elections" },
];

export default function Markets() {
  const [searchQuery, setSearchQuery] = useState("");
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedMarket, setSelectedMarket] = useState<PolyMarket | null>(null);
  const [viewTab, setViewTab] = useState<"live" | "results">("live");
  const [categorySlug, setCategorySlug] = useState("");
  const { toast } = useToast();

  const { data: markets, isLoading } = useQuery<PolyMarket[]>({
    queryKey: ["/api/markets", searchTerm, viewTab, categorySlug],
    queryFn: async () => {
      const params = new URLSearchParams({ limit: "100" });
      if (searchTerm) params.set("search", searchTerm);
      if (viewTab === "results") params.set("closed", "true");
      if (categorySlug) params.set("tag", categorySlug);
      const res = await fetch(`/api/markets?${params}`);
      if (!res.ok) throw new Error("Failed to fetch markets");
      const data = await res.json();
      if (Array.isArray(data)) return data;
      if (data.markets) return data.markets;
      return [];
    },
    refetchInterval: viewTab === "live" ? 30000 : false,
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

  const handleSearch = () => setSearchTerm(searchQuery);

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-semibold tracking-tight">Markets</h2>
        <p className="text-sm text-muted-foreground mt-0.5">
          Browse and search Polymarket prediction markets
        </p>
      </div>

      {/* Live / Results tabs */}
      <div className="flex gap-1 border-b border-border pb-0">
        {(["live", "results"] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => { setViewTab(tab); setSearchTerm(""); setSearchQuery(""); }}
            className={cn(
              "relative px-4 py-2 text-sm font-medium transition-colors capitalize",
              viewTab === tab
                ? "text-foreground after:absolute after:bottom-0 after:left-0 after:right-0 after:h-0.5 after:bg-primary after:rounded-t"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {tab === "live" ? (
              <span className="flex items-center gap-1.5">
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500" />
                </span>
                Live
              </span>
            ) : (
              <span className="flex items-center gap-1.5">
                <CheckCircle2 className="w-3.5 h-3.5" />
                Results
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Category tabs */}
      <div className="flex gap-1.5 overflow-x-auto pb-1 scrollbar-none">
        {CATEGORY_TABS.map((cat) => (
          <button
            key={cat.slug}
            onClick={() => setCategorySlug(cat.slug)}
            className={cn(
              "shrink-0 px-3 py-1.5 rounded-full text-xs font-medium transition-colors whitespace-nowrap",
              categorySlug === cat.slug
                ? "bg-primary text-primary-foreground"
                : "bg-muted text-muted-foreground hover:bg-muted/80 hover:text-foreground"
            )}
          >
            {cat.label}
          </button>
        ))}
      </div>

      {/* Search bar */}
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder={`Search ${viewTab === "live" ? "live" : "closed"} markets...`}
            className="pl-9"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSearch()}
          />
        </div>
        <Button onClick={handleSearch}>Search</Button>
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
              {searchTerm ? "No markets found for your search." : `No ${viewTab} markets available.`}
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
            const isClosed = viewTab === "results";

            return (
              <Card
                key={market.id || market.conditionId}
                className="hover:bg-muted/30 transition-colors cursor-pointer"
              >
                <CardContent className="py-3.5 px-4">
                  <div className="flex items-start gap-3">
                    {(market.image || market._eventImage) && (
                      <img
                        src={market.image || market._eventImage}
                        alt=""
                        className="w-10 h-10 rounded-md object-cover shrink-0 mt-0.5"
                      />
                    )}
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium leading-snug">
                        {market.question}
                      </p>
                      <div className="flex items-center gap-3 mt-1.5 flex-wrap">
                        {yesPrice !== null && (
                          <span className="text-xs font-mono">
                            <span className="text-muted-foreground">Yes: </span>
                            <span className={cn("font-medium", isClosed ? "text-foreground" : "text-profit")}>
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
                            {isClosed ? "Ended" : "Ends"} {new Date(market.endDate).toLocaleDateString()}
                          </span>
                        )}
                        {isClosed && (
                          <Badge variant="secondary" className="text-[10px] h-4 px-1.5">
                            Closed
                          </Badge>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        onClick={(e) => { e.stopPropagation(); setSelectedMarket(market); }}
                      >
                        <Eye className="w-3.5 h-3.5" />
                      </Button>
                      {!isClosed && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          onClick={(e) => { e.stopPropagation(); addToWatchlist.mutate(market); }}
                        >
                          <Star className="w-3.5 h-3.5" />
                        </Button>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

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
              <div key={i} className="rounded-lg border p-3 text-center">
                <p className="text-xs text-muted-foreground mb-1">{outcome}</p>
                <p className="text-lg font-semibold font-mono">
                  {prices[i] ? (parseFloat(prices[i]) * 100).toFixed(1) + "%" : "—"}
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
