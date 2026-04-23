import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetFooter,
} from "@/components/ui/sheet";
import {
  Zap, BookOpen, TrendingUp, Link2,
  Settings2, RefreshCw, Trophy, TrendingDown, Minus,
  Radio, ArrowUpCircle, ArrowDownCircle
} from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import type { Strategy } from "@shared/schema";

// Fixed strategy metadata (matches server seeds by name)
const STRATEGY_META = [
  {
    name: "Last-Second Momentum Snipe",
    icon: Zap,
    iconColor: "text-yellow-400",
    iconBg: "bg-yellow-400/10",
    defaultConfig: { triggerPrice: 0.48, orderSize: 10, momentumThreshold: 0.65, minSecondsLeft: 45 },
    fields: [
      { key: "triggerPrice", label: "Trigger (Up price <)", type: "percent" },
      { key: "orderSize", label: "Order size (USDC)", type: "number" },
      { key: "momentumThreshold", label: "Momentum threshold", type: "percent" },
      { key: "minSecondsLeft", label: "Min seconds left", type: "number" },
    ],
    description: "Paper-buy YES late in the active BTC candle when short-term momentum is positive and the YES price still looks cheap.",
  },
  {
    name: "Orderbook Arbitrage & Imbalance",
    icon: BookOpen,
    iconColor: "text-blue-400",
    iconBg: "bg-blue-400/10",
    defaultConfig: { orderSize: 10, imbalanceThreshold: 0.18, maxEntryPrice: 0.56, minSecondsLeft: 40 },
    fields: [
      { key: "orderSize", label: "Order size (USDC)", type: "number" },
      { key: "imbalanceThreshold", label: "Imbalance threshold", type: "percent" },
      { key: "maxEntryPrice", label: "Max entry price", type: "percent" },
      { key: "minSecondsLeft", label: "Min seconds left", type: "number" },
    ],
    description: "Paper-trade the side that still looks underpriced when YES and NO book depth diverge sharply on the current BTC candle.",
  },
  {
    name: "Spot Correlation Reversion Scalp",
    icon: TrendingUp,
    iconColor: "text-green-400",
    iconBg: "bg-green-400/10",
    defaultConfig: { triggerPrice: 0.46, orderSize: 10, reboundThreshold: 0.0025, windowBars: 8, minSecondsLeft: 60 },
    fields: [
      { key: "triggerPrice", label: "Polymarket Up trigger <", type: "percent" },
      { key: "reboundThreshold", label: "Spot rebound >%", type: "percent" },
      { key: "windowBars", label: "Lookback bars", type: "number" },
      { key: "orderSize", label: "Order size (USDC)", type: "number" },
      { key: "minSecondsLeft", label: "Min seconds left", type: "number" },
    ],
    description: "Paper-buy YES after a short BTC rebound when the current candle market is still pricing in too much downside.",
  },
  {
    name: "Oracle Lead Arbitrage",
    icon: Link2,
    iconColor: "text-purple-400",
    iconBg: "bg-purple-400/10",
    defaultConfig: { orderSize: 10, spotMoveThreshold: 0.002, maxEntryPrice: 0.6, minSecondsLeft: 75 },
    fields: [
      { key: "spotMoveThreshold", label: "Spot delta trigger >%", type: "percent" },
      { key: "orderSize", label: "Order size (USDC)", type: "number" },
      { key: "maxEntryPrice", label: "Max entry price", type: "percent" },
      { key: "minSecondsLeft", label: "Min seconds left", type: "number" },
    ],
    description: "Paper-trade the lagging side of the BTC candle when spot moves first and the Polymarket price has not caught up yet.",
  },
];

interface LastTrade {
  id: number;
  side: string;
  outcome: string;
  netPnl: number | null;
  pnl: number | null;
  status: string;
  timestamp: string;
  marketQuestion: string | null;
}

interface PnlData {
  totalPnl: number;
  totalWins: number;
  totalLosses: number;
  paperBalance: number;
  perStrategy: {
    id: number;
    name: string;
    totalPnl: number;
    winCount: number;
    lossCount: number;
    totalExecutions: number;
    winRate: string | null;
  }[];
}

export default function Strategies() {
  const [settingsFor, setSettingsFor] = useState<Strategy | null>(null);
  const { toast } = useToast();

  const { data: strategies } = useQuery<Strategy[]>({
    queryKey: ["/api/strategies"],
    refetchInterval: 10000,
  });

  const { data: pnl } = useQuery<PnlData>({
    queryKey: ["/api/pnl"],
    refetchInterval: 15000,
  });

  const { data: lastTrades } = useQuery<Record<number, LastTrade>>({
    queryKey: ["/api/trades/last-per-strategy"],
    refetchInterval: 15000,
  });

  const toggleMutation = useMutation({
    mutationFn: ({ id, isActive }: { id: number; isActive: boolean }) =>
      apiRequest("POST", `/api/strategies/${id}/toggle`, { isActive }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/strategies"] });
      queryClient.invalidateQueries({ queryKey: ["/api/bot/status"] });
    },
    onError: (e: Error) => {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    },
  });

  // Match DB strategies to meta by name (order preserved)
  const cards = STRATEGY_META.map((meta) => {
    const strategy = strategies?.find((s) => s.name === meta.name) ?? null;
    const pnlRow = pnl?.perStrategy.find((p) => p.name === meta.name) ?? null;
    const lastTrade = strategy && lastTrades ? lastTrades[strategy.id] ?? null : null;
    return { meta, strategy, pnlRow, lastTrade };
  });

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-semibold tracking-tight">Strategies</h2>
        <p className="text-sm text-muted-foreground mt-0.5">
          Toggle paper strategies on or off. Each one auto-rolls on the current BTC 5-minute candle market.
        </p>
      </div>

      {cards.map(({ meta, strategy, pnlRow, lastTrade }) => {
        const Icon = meta.icon;
        const isActive = strategy?.isActive ?? false;
        const config = strategy?.config ? (() => { try { return JSON.parse(strategy.config!); } catch { return {}; } })() : meta.defaultConfig;
        const totalPnl = pnlRow?.totalPnl ?? 0;
        const winRate = pnlRow?.winRate ? parseFloat(pnlRow.winRate) : null;

        return (
          <Card
            key={meta.name}
            className={cn(
              "transition-colors",
              isActive && "border-primary/40 bg-primary/[0.03]"
            )}
          >
            <CardContent className="py-4 px-5">
              <div className="flex items-start gap-4">
                {/* Icon */}
                <div className={cn("w-10 h-10 rounded-full flex items-center justify-center shrink-0 mt-0.5", meta.iconBg)}>
                  <Icon className={cn("w-5 h-5", meta.iconColor)} />
                </div>

                {/* Body */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h3 className="text-sm font-semibold">{meta.name}</h3>
                    {isActive && (
                      <Badge className="text-[10px] h-4 px-1.5 gap-1">
                        <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse inline-block" />
                        Active
                      </Badge>
                    )}
                    <Badge variant="outline" className="text-[10px] h-4 px-1.5 gap-1 text-orange-400 border-orange-500/40">
                      <RefreshCw className="w-2.5 h-2.5" />
                      Auto-Roll
                    </Badge>
                  </div>

                  <p className="text-xs text-muted-foreground mt-1 leading-relaxed line-clamp-2">
                    {meta.description}
                  </p>

                  {/* Current market + last trade */}
                  {(strategy?.marketQuestion || lastTrade) && (
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-2">
                      {strategy?.marketQuestion && (
                        <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                          <Radio className="w-3 h-3 text-blue-400" />
                          <span className="truncate max-w-[220px]">{strategy.marketQuestion}</span>
                        </span>
                      )}
                      {lastTrade && (
                        <span className={cn(
                          "flex items-center gap-1 text-[11px] font-mono",
                          (lastTrade.netPnl ?? lastTrade.pnl ?? 0) > 0
                            ? "text-profit"
                            : (lastTrade.netPnl ?? lastTrade.pnl ?? 0) < 0
                            ? "text-loss"
                            : "text-muted-foreground"
                        )}>
                          {lastTrade.side === "BUY" ? (
                            <ArrowUpCircle className="w-3 h-3" />
                          ) : (
                            <ArrowDownCircle className="w-3 h-3" />
                          )}
                          Last: {(lastTrade.netPnl ?? lastTrade.pnl ?? 0) >= 0 ? "+" : ""}
                          {(lastTrade.netPnl ?? lastTrade.pnl ?? 0).toFixed(2)} USDC
                        </span>
                      )}
                    </div>
                  )}

                  {/* P&L row */}
                  <div className="flex items-center gap-4 mt-2.5 flex-wrap">
                    <span className="text-xs flex items-center gap-1">
                      {totalPnl > 0 ? (
                        <Trophy className="w-3 h-3 text-profit" />
                      ) : totalPnl < 0 ? (
                        <TrendingDown className="w-3 h-3 text-loss" />
                      ) : (
                        <Minus className="w-3 h-3 text-muted-foreground" />
                      )}
                      <span className={cn(
                        "font-mono font-medium",
                        totalPnl > 0 ? "text-profit" : totalPnl < 0 ? "text-loss" : "text-muted-foreground"
                      )}>
                        {totalPnl >= 0 ? "+" : ""}{totalPnl.toFixed(2)} USDC
                      </span>
                    </span>
                    {winRate !== null && (
                      <span className="text-xs text-muted-foreground">
                        {winRate.toFixed(0)}% win rate
                      </span>
                    )}
                    {pnlRow && (
                      <span className="text-xs text-muted-foreground">
                        {pnlRow.totalExecutions} trades · {pnlRow.winCount}W / {pnlRow.lossCount}L
                      </span>
                    )}
                    {config.orderSize && (
                      <span className="text-xs text-muted-foreground">
                        ${config.orderSize}/candle
                      </span>
                    )}
                  </div>
                </div>

                {/* Controls */}
                <div className="flex items-center gap-3 shrink-0">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    onClick={() => strategy && setSettingsFor(strategy)}
                    disabled={!strategy}
                    title="Strategy settings"
                  >
                    <Settings2 className="w-3.5 h-3.5" />
                  </Button>
                  <Switch
                    checked={isActive}
                    disabled={!strategy || toggleMutation.isPending}
                    onCheckedChange={(checked) => {
                      if (strategy) toggleMutation.mutate({ id: strategy.id, isActive: checked });
                    }}
                  />
                </div>
              </div>
            </CardContent>
          </Card>
        );
      })}

      {settingsFor && (
        <StrategySettingsSheet
          strategy={settingsFor}
          meta={STRATEGY_META.find((m) => m.name === settingsFor.name)!}
          onClose={() => setSettingsFor(null)}
        />
      )}
    </div>
  );
}

// ─── Settings Sheet ──────────────────────────────────────────────────────────

function StrategySettingsSheet({
  strategy,
  meta,
  onClose,
}: {
  strategy: Strategy;
  meta: typeof STRATEGY_META[0];
  onClose: () => void;
}) {
  const { toast } = useToast();
  const existingConfig = strategy.config
    ? (() => { try { return JSON.parse(strategy.config!); } catch { return {}; } })()
    : meta.defaultConfig;

  const [config, setConfig] = useState<Record<string, number>>({ ...meta.defaultConfig, ...existingConfig });
  const [orderSize, setOrderSize] = useState(String(strategy.orderSize));

  const saveMutation = useMutation({
    mutationFn: async () => {
      const newConfig = { ...config, orderSize: parseFloat(orderSize) };
      await apiRequest("PATCH", `/api/strategies/${strategy.id}`, {
        orderSize: parseFloat(orderSize),
        triggerPrice: config.triggerPrice ?? strategy.triggerPrice,
        config: JSON.stringify(newConfig),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/strategies"] });
      toast({ title: "Settings saved" });
      onClose();
    },
    onError: (e: Error) => {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    },
  });

  const formatVal = (key: string, val: number) => {
    const field = meta.fields.find((f) => f.key === key);
    if (field?.type === "percent") return (val * 100).toFixed(1);
    return String(val);
  };

  const parseVal = (key: string, raw: string) => {
    const field = meta.fields.find((f) => f.key === key);
    const n = parseFloat(raw);
    if (field?.type === "percent") return n / 100;
    return n;
  };

  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full sm:max-w-md">
        <SheetHeader>
          <SheetTitle className="text-base">{meta.name}</SheetTitle>
        </SheetHeader>

        <div className="space-y-4 mt-6 px-1">
          <p className="text-xs text-muted-foreground leading-relaxed">{meta.description}</p>

          <div className="space-y-3">
            {meta.fields.map((field) => (
              <div key={field.key} className="flex items-center gap-3">
                <Label className="text-xs w-44 shrink-0">{field.label}</Label>
                <div className="flex items-center gap-1.5 flex-1">
                  <Input
                    type="number"
                    step={field.type === "percent" ? "0.1" : "1"}
                    min="0"
                    value={field.key === "orderSize" ? orderSize : formatVal(field.key, config[field.key] ?? 0)}
                    onChange={(e) => {
                      if (field.key === "orderSize") {
                        setOrderSize(e.target.value);
                      } else {
                        setConfig((prev) => ({ ...prev, [field.key]: parseVal(field.key, e.target.value) }));
                      }
                    }}
                    className="font-mono"
                  />
                  {field.type === "percent" && (
                    <span className="text-xs text-muted-foreground">%</span>
                  )}
                  {field.key === "minSecondsLeft" && (
                    <span className="text-xs text-muted-foreground">sec</span>
                  )}
                  {field.key === "windowBars" && (
                    <span className="text-xs text-muted-foreground">bars</span>
                  )}
                  {field.key === "orderSize" && (
                    <span className="text-xs text-muted-foreground">$</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>

        <SheetFooter className="mt-8">
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending}>
            Save
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
