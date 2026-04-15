import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Plus, Play, Trash2, Power, RefreshCw, Bitcoin, ChevronRight, Zap } from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import type { Strategy } from "@shared/schema";

interface BtcCandleMarket {
  event: {
    title: string;
    endDate: string;
    startDate: string;
  };
  market: {
    conditionId: string;
    clobTokenIds?: string;
    outcomePrices?: string;
    outcomes?: string;
  } | null;
}

export default function Strategies() {
  const [showCreate, setShowCreate] = useState(false);
  const [showBtcSetup, setShowBtcSetup] = useState(false);
  const { toast } = useToast();

  const { data: strategies, isLoading } = useQuery<Strategy[]>({
    queryKey: ["/api/strategies"],
  });

  // Live BTC candle for the quick-setup card
  const { data: btcCandle } = useQuery<BtcCandleMarket>({
    queryKey: ["/api/markets/btc-candle/current"],
    queryFn: async () => {
      const res = await fetch("/api/markets/btc-candle/current");
      if (!res.ok) return null;
      return res.json();
    },
    refetchInterval: 30000,
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/strategies/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/strategies"] });
      queryClient.invalidateQueries({ queryKey: ["/api/bot/status"] });
    },
  });

  const toggleMutation = useMutation({
    mutationFn: ({ id, isActive }: { id: number; isActive: boolean }) =>
      apiRequest("POST", `/api/strategies/${id}/toggle`, { isActive }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/strategies"] });
      queryClient.invalidateQueries({ queryKey: ["/api/bot/status"] });
    },
  });

  const simulateMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await apiRequest("POST", `/api/strategies/${id}/simulate`);
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/strategies"] });
      queryClient.invalidateQueries({ queryKey: ["/api/bot/status"] });
      queryClient.invalidateQueries({ queryKey: ["/api/trades"] });
      toast({
        title: data.triggered ? "Strategy Triggered" : "Not Triggered",
        description: `Current: ${(data.currentPrice * 100).toFixed(1)}% | Trigger: ${(data.triggerPrice * 100).toFixed(1)}%`,
      });
    },
    onError: (e: Error) => {
      toast({ title: "Simulation failed", description: e.message, variant: "destructive" });
    },
  });

  // Check if there's already an auto-roll BTC strategy
  const btcAutoRollStrategy = strategies?.find((s) => s.autoRoll);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">Strategies</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            Automated trading rules and triggers
          </p>
        </div>
        <Button onClick={() => setShowCreate(true)} data-testid="button-create-strategy">
          <Plus className="w-4 h-4 mr-1.5" />
          New Strategy
        </Button>
      </div>

      {/* BTC 5-min Auto-Roll Quick Setup */}
      {!btcAutoRollStrategy && (
        <Card
          className="border-primary/30 bg-primary/5 cursor-pointer hover:bg-primary/10 transition-colors"
          onClick={() => setShowBtcSetup(true)}
        >
          <CardContent className="py-4 px-5">
            <div className="flex items-center gap-4">
              <div className="w-10 h-10 rounded-full bg-orange-500/15 flex items-center justify-center shrink-0">
                <Bitcoin className="w-5 h-5 text-orange-400" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-semibold">BTC 5-Min Up/Down — Auto-Roll</p>
                  <Badge className="text-[10px] h-4 px-1.5 bg-orange-500/20 text-orange-400 border-orange-500/30">
                    Quick Setup
                  </Badge>
                </div>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {btcCandle?.event
                    ? `Now: ${btcCandle.event.title} · ends ${new Date(btcCandle.event.endDate).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
                    : "Automatically trades each 5-min candle and rolls to the next"}
                </p>
              </div>
              <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
            </div>
          </CardContent>
        </Card>
      )}

      {/* Strategy list */}
      {!strategies || strategies.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <p className="text-sm text-muted-foreground">
              No strategies yet. Create one above or use the BTC quick setup.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {strategies.map((s) => (
            <Card key={s.id} data-testid={`strategy-card-${s.id}`}>
              <CardContent className="py-4 px-5">
                <div className="flex items-start gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h3 className="text-sm font-semibold">{s.name}</h3>
                      <Badge variant={s.isActive ? "default" : "secondary"} className="text-[11px]">
                        {s.isActive ? "Active" : "Paused"}
                      </Badge>
                      {s.autoRoll && (
                        <Badge variant="outline" className="text-[10px] h-4 px-1.5 text-orange-400 border-orange-500/40 gap-1">
                          <RefreshCw className="w-2.5 h-2.5" />
                          Auto-Roll
                        </Badge>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground mt-1 truncate">
                      {s.marketQuestion || "No market linked"}
                    </p>
                    <div className="flex items-center gap-4 mt-2.5 flex-wrap">
                      <span className="text-xs">
                        <span className="text-muted-foreground">Side:</span>{" "}
                        <span className="font-medium">{s.side}</span>
                      </span>
                      {!s.autoRoll && (
                        <span className="text-xs">
                          <span className="text-muted-foreground">Trigger:</span>{" "}
                          <span className="font-medium font-mono">
                            {s.triggerType === "price_below" ? "< " : "> "}
                            {(s.triggerPrice * 100).toFixed(1)}%
                          </span>
                        </span>
                      )}
                      <span className="text-xs">
                        <span className="text-muted-foreground">Size:</span>{" "}
                        <span className="font-medium font-mono">${s.orderSize}</span>
                      </span>
                      <span className="text-xs">
                        <span className="text-muted-foreground">Runs:</span>{" "}
                        <span className="font-medium font-mono">{s.totalExecutions}</span>
                      </span>
                      {s.autoRoll && s.currentConditionId && (
                        <span className="text-xs text-muted-foreground font-mono truncate max-w-[120px]">
                          cid: {s.currentConditionId.slice(0, 10)}…
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    {!s.autoRoll && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        onClick={() => simulateMutation.mutate(s.id)}
                        disabled={simulateMutation.isPending}
                        title="Simulate"
                      >
                        <Play className="w-3.5 h-3.5" />
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => toggleMutation.mutate({ id: s.id, isActive: !s.isActive })}
                      title={s.isActive ? "Pause" : "Activate"}
                    >
                      <Power className={cn("w-3.5 h-3.5", s.isActive && "text-primary")} />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-destructive"
                      onClick={() => deleteMutation.mutate(s.id)}
                      title="Delete"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <CreateStrategyDialog open={showCreate} onClose={() => setShowCreate(false)} />
      <BtcAutoRollDialog
        open={showBtcSetup}
        onClose={() => setShowBtcSetup(false)}
        btcCandle={btcCandle ?? null}
      />
    </div>
  );
}

// ─── BTC Auto-Roll Setup Dialog ────────────────────────────────────────────

function BtcAutoRollDialog({
  open,
  onClose,
  btcCandle,
}: {
  open: boolean;
  onClose: () => void;
  btcCandle: BtcCandleMarket | null;
}) {
  const { toast } = useToast();
  const [form, setForm] = useState({
    side: "YES",
    orderSize: "10",
    orderType: "MARKET",
  });

  const market = btcCandle?.market;
  const tokenIds = market?.clobTokenIds ? JSON.parse(market.clobTokenIds) : [];
  const prices = market?.outcomePrices ? JSON.parse(market.outcomePrices) : [];
  const outcomes = market?.outcomes ? JSON.parse(market.outcomes) : ["Yes", "No"];

  const createMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("POST", "/api/strategies", {
        name: "BTC 5-Min Auto-Roll",
        marketQuestion: btcCandle?.event?.title || "Bitcoin Up or Down - 5 Minutes",
        tokenId: tokenIds[form.side === "YES" ? 0 : 1] || null,
        conditionId: market?.conditionId || null,
        side: form.side,
        triggerType: "price_above", // always-on for auto-roll
        triggerPrice: 0,            // triggers immediately (price is always > 0)
        orderSize: parseFloat(form.orderSize),
        orderType: form.orderType,
        limitPrice: null,
        cooldownMinutes: 5,
        isActive: true,
        autoRoll: true,
        currentConditionId: market?.conditionId || null,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/strategies"] });
      queryClient.invalidateQueries({ queryKey: ["/api/bot/status"] });
      toast({ title: "BTC Auto-Roll strategy created", description: "Bot will trade each 5-min candle automatically." });
      onClose();
    },
    onError: (e: Error) => {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    },
  });

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Bitcoin className="w-4 h-4 text-orange-400" />
            BTC 5-Min Auto-Roll Strategy
          </DialogTitle>
        </DialogHeader>

        {/* Current candle preview */}
        {btcCandle?.event && (
          <div className="rounded-lg border border-border bg-muted/40 px-4 py-3 space-y-2">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Current Candle</p>
            <p className="text-sm font-medium">{btcCandle.event.title}</p>
            <div className="flex gap-3">
              {outcomes.map((o: string, i: number) => (
                <div key={o} className="flex items-center gap-1.5">
                  <span className="text-xs text-muted-foreground">{o}:</span>
                  <span className="text-xs font-mono font-semibold">
                    {prices[i] ? (parseFloat(prices[i]) * 100).toFixed(0) + "¢" : "—"}
                  </span>
                </div>
              ))}
              <span className="text-xs text-muted-foreground ml-auto">
                ends {new Date(btcCandle.event.endDate).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              </span>
            </div>
          </div>
        )}

        <div className="space-y-4 mt-1">
          <div className="rounded-lg border border-primary/20 bg-primary/5 px-4 py-3 flex items-start gap-3">
            <RefreshCw className="w-4 h-4 text-primary mt-0.5 shrink-0" />
            <p className="text-xs text-muted-foreground leading-relaxed">
              The bot will trade the current candle, then automatically detect when it closes
              and roll to the next one. It runs continuously while active.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs">Direction</Label>
              <Select value={form.side} onValueChange={(v) => setForm({ ...form, side: v })}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="YES">Up (Yes)</SelectItem>
                  <SelectItem value="NO">Down (No)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs">Order Type</Label>
              <Select value={form.orderType} onValueChange={(v) => setForm({ ...form, orderType: v })}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="MARKET">Market</SelectItem>
                  <SelectItem value="LIMIT">Limit</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div>
            <Label htmlFor="btcSize" className="text-xs">Order Size (USDC) per candle</Label>
            <Input
              id="btcSize"
              type="number"
              step="1"
              min="1"
              value={form.orderSize}
              onChange={(e) => setForm({ ...form, orderSize: e.target.value })}
              className="font-mono"
            />
          </div>
        </div>

        <DialogFooter className="mt-4">
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button
            onClick={() => createMutation.mutate()}
            disabled={createMutation.isPending}
            className="gap-1.5"
          >
            <Zap className="w-3.5 h-3.5" />
            Start Auto-Roll
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Regular Strategy Create Dialog ────────────────────────────────────────

function CreateStrategyDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { toast } = useToast();
  const [form, setForm] = useState({
    name: "",
    marketQuestion: "",
    tokenId: "",
    conditionId: "",
    side: "YES",
    triggerType: "price_below",
    triggerPrice: "0.30",
    orderSize: "10",
    orderType: "LIMIT",
    limitPrice: "",
    cooldownMinutes: "5",
    isActive: true,
  });

  const createMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("POST", "/api/strategies", {
        name: form.name,
        marketQuestion: form.marketQuestion || null,
        tokenId: form.tokenId || null,
        conditionId: form.conditionId || null,
        side: form.side,
        triggerType: form.triggerType,
        triggerPrice: parseFloat(form.triggerPrice),
        orderSize: parseFloat(form.orderSize),
        orderType: form.orderType,
        limitPrice: form.limitPrice ? parseFloat(form.limitPrice) : null,
        cooldownMinutes: parseInt(form.cooldownMinutes),
        isActive: form.isActive,
        autoRoll: false,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/strategies"] });
      queryClient.invalidateQueries({ queryKey: ["/api/bot/status"] });
      toast({ title: "Strategy created" });
      onClose();
      setForm({
        name: "", marketQuestion: "", tokenId: "", conditionId: "",
        side: "YES", triggerType: "price_below", triggerPrice: "0.30",
        orderSize: "10", orderType: "LIMIT", limitPrice: "",
        cooldownMinutes: "5", isActive: true,
      });
    },
    onError: (e: Error) => {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    },
  });

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>New Strategy</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 mt-2">
          <div>
            <Label htmlFor="name" className="text-xs">Strategy Name</Label>
            <Input
              id="name"
              data-testid="input-strategy-name"
              placeholder="e.g. Buy YES on dip"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </div>
          <div>
            <Label htmlFor="question" className="text-xs">Market Question (optional)</Label>
            <Input
              id="question"
              data-testid="input-market-question"
              placeholder="Market description for reference"
              value={form.marketQuestion}
              onChange={(e) => setForm({ ...form, marketQuestion: e.target.value })}
            />
          </div>
          <div>
            <Label htmlFor="tokenId" className="text-xs">CLOB Token ID</Label>
            <Input
              id="tokenId"
              data-testid="input-token-id"
              placeholder="Paste from market detail"
              value={form.tokenId}
              onChange={(e) => setForm({ ...form, tokenId: e.target.value })}
              className="font-mono text-xs"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs">Side</Label>
              <Select value={form.side} onValueChange={(v) => setForm({ ...form, side: v })}>
                <SelectTrigger data-testid="select-side"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="YES">YES</SelectItem>
                  <SelectItem value="NO">NO</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs">Trigger</Label>
              <Select value={form.triggerType} onValueChange={(v) => setForm({ ...form, triggerType: v })}>
                <SelectTrigger data-testid="select-trigger-type"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="price_below">Price Below</SelectItem>
                  <SelectItem value="price_above">Price Above</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="triggerPrice" className="text-xs">Trigger Price (0-1)</Label>
              <Input
                id="triggerPrice"
                data-testid="input-trigger-price"
                type="number" step="0.01" min="0" max="1"
                value={form.triggerPrice}
                onChange={(e) => setForm({ ...form, triggerPrice: e.target.value })}
                className="font-mono"
              />
            </div>
            <div>
              <Label htmlFor="orderSize" className="text-xs">Order Size (USDC)</Label>
              <Input
                id="orderSize"
                data-testid="input-order-size"
                type="number" step="1" min="1"
                value={form.orderSize}
                onChange={(e) => setForm({ ...form, orderSize: e.target.value })}
                className="font-mono"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs">Order Type</Label>
              <Select value={form.orderType} onValueChange={(v) => setForm({ ...form, orderType: v })}>
                <SelectTrigger data-testid="select-order-type"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="LIMIT">Limit</SelectItem>
                  <SelectItem value="MARKET">Market</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="cooldown" className="text-xs">Cooldown (min)</Label>
              <Input
                id="cooldown"
                data-testid="input-cooldown"
                type="number" step="1" min="1"
                value={form.cooldownMinutes}
                onChange={(e) => setForm({ ...form, cooldownMinutes: e.target.value })}
                className="font-mono"
              />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Switch
              checked={form.isActive}
              onCheckedChange={(c) => setForm({ ...form, isActive: c })}
              data-testid="switch-active"
            />
            <Label className="text-xs">Start active immediately</Label>
          </div>
        </div>
        <DialogFooter className="mt-4">
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button
            onClick={() => createMutation.mutate()}
            disabled={!form.name || createMutation.isPending}
            data-testid="button-submit-strategy"
          >
            Create Strategy
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
