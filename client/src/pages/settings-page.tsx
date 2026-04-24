import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useState, useEffect } from "react";
import { Shield, AlertTriangle, DollarSign, TrendingDown, Globe, Zap } from "lucide-react";
import type { BotSetting } from "@shared/schema";

export default function SettingsPage() {
  const { toast } = useToast();

  const { data: settings } = useQuery<BotSetting[]>({
    queryKey: ["/api/settings"],
  });

  const getVal = (key: string, def: string = "") =>
    settings?.find((s) => s.key === key)?.value || def;

  const [mode, setMode] = useState("paper");
  const [pollingInterval, setPollingInterval] = useState("30");
  const [maxDailyTrades, setMaxDailyTrades] = useState("50");
  const [maxOrderSize, setMaxOrderSize] = useState("100");
  const [takerFeeRate, setTakerFeeRate] = useState("1.0");
  const [drawdownLimit, setDrawdownLimit] = useState("10");
  const [multiSourceVerify, setMultiSourceVerify] = useState(true);

  useEffect(() => {
    if (settings) {
      setMode(getVal("mode", "paper"));
      setPollingInterval(getVal("polling_interval", "5"));
      setMaxDailyTrades(getVal("max_daily_trades", "50"));
      setMaxOrderSize(getVal("max_order_size", "100"));
      setTakerFeeRate((parseFloat(getVal("taker_fee_rate", "0.072")) * 100).toFixed(1));
      setDrawdownLimit((parseFloat(getVal("drawdown_limit", "0.10")) * 100).toFixed(0));
      setMultiSourceVerify(getVal("multi_source_verify", "true") === "true");
    }
  }, [settings]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      const pairs: [string, string][] = [
        ["mode", mode],
        ["polling_interval", pollingInterval],
        ["max_daily_trades", maxDailyTrades],
        ["max_order_size", maxOrderSize],
        ["taker_fee_rate", String(parseFloat(takerFeeRate) / 100)],
        ["drawdown_limit", String(parseFloat(drawdownLimit) / 100)],
        ["multi_source_verify", String(multiSourceVerify)],
      ];
      for (const [key, value] of pairs) {
        await apiRequest("POST", "/api/settings", { key, value });
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/settings"] });
      queryClient.invalidateQueries({ queryKey: ["/api/bot/status"] });
      toast({ title: "Settings saved" });
    },
    onError: (e: Error) => {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    },
  });

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold tracking-tight">Settings</h2>
        <p className="text-sm text-muted-foreground mt-0.5">
          Configure bot behavior, fees, and safety limits
        </p>
      </div>

      {/* Trading Mode */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <Shield className="w-4 h-4 text-primary" />
            <CardTitle className="text-sm font-medium">Execution Mode</CardTitle>
          </div>
          <CardDescription className="text-xs">
            This rebuild stays in paper mode while you validate the rolling BTC 5-minute workflow.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-3">
            <Badge variant="secondary">Paper Only</Badge>
            <p className="text-xs text-muted-foreground">
              Live order placement is intentionally disabled.
            </p>
          </div>
          <div className="flex items-start gap-2 mt-3 p-3 rounded-md bg-destructive/10 border border-destructive/20">
            <AlertTriangle className="w-4 h-4 text-destructive shrink-0 mt-0.5" />
            <p className="text-xs text-destructive">
              The engine only opens paper positions on BTC 5-minute markets and rolls them forward automatically.
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Fees */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <DollarSign className="w-4 h-4 text-primary" />
            <CardTitle className="text-sm font-medium">Fee Handling</CardTitle>
          </div>
          <CardDescription className="text-xs">
            Paper entries use the Polymarket crypto taker-fee model.
            Since these candle trades settle by market resolution, the paper engine charges entry-side fees only.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-3">
            <Label className="text-xs w-40 shrink-0">Taker fee rate</Label>
            <Input
              type="number"
              step="0.1"
              min="0"
              max="5"
              value={takerFeeRate}
              onChange={(e) => setTakerFeeRate(e.target.value)}
              className="w-24 font-mono"
            />
            <span className="text-xs text-muted-foreground">fee coefficient</span>
          </div>
          <p className="text-xs text-muted-foreground mt-2">
            BTC candle markets default to <span className="font-mono font-medium">7.2%</span>, matching the official crypto fee coefficient.
          </p>
        </CardContent>
      </Card>

      {/* Safeguards */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <TrendingDown className="w-4 h-4 text-primary" />
            <CardTitle className="text-sm font-medium">Safeguards</CardTitle>
          </div>
          <CardDescription className="text-xs">
            Circuit breakers protect your account from runaway losses.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-3">
            <Label className="text-xs w-40 shrink-0">Daily drawdown limit</Label>
            <Input
              type="number"
              step="1"
              min="1"
              max="50"
              value={drawdownLimit}
              onChange={(e) => setDrawdownLimit(e.target.value)}
              className="w-24 font-mono"
            />
            <span className="text-xs text-muted-foreground">%</span>
          </div>
          <p className="text-xs text-muted-foreground">
            If today's losses exceed <span className="font-mono font-medium">{drawdownLimit}%</span> of opening balance, all strategies pause automatically.
          </p>
        </CardContent>
      </Card>

      {/* Multi-source verification */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <Globe className="w-4 h-4 text-primary" />
            <CardTitle className="text-sm font-medium">Multi-Source Verification</CardTitle>
          </div>
          <CardDescription className="text-xs">
            Require BTC spot data to confirm a paper entry before the bot opens the next rolling candle position.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-3">
            <Switch
              checked={multiSourceVerify}
              onCheckedChange={setMultiSourceVerify}
            />
            <Label className="text-xs">
              {multiSourceVerify ? "Enabled — spot data must confirm entries" : "Disabled — using Polymarket price action only"}
            </Label>
          </div>
        </CardContent>
      </Card>

      {/* Polling */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <Zap className="w-4 h-4 text-primary" />
            <CardTitle className="text-sm font-medium">Strategy Polling</CardTitle>
          </div>
          <CardDescription className="text-xs">
            How frequently the bot checks market conditions against triggers.
            Lower = faster but higher API load.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-3">
            <Label className="text-xs shrink-0">Check every</Label>
            <Input
              type="number"
              min="5"
              max="300"
              value={pollingInterval}
              onChange={(e) => setPollingInterval(e.target.value)}
              className="w-24 font-mono"
            />
            <span className="text-xs text-muted-foreground">seconds</span>
          </div>
          <div className="flex items-center gap-3">
            <Label className="text-xs w-40 shrink-0">Max daily trades</Label>
            <Input
              type="number"
              min="1"
              value={maxDailyTrades}
              onChange={(e) => setMaxDailyTrades(e.target.value)}
              className="w-24 font-mono"
            />
          </div>
          <div className="flex items-center gap-3">
            <Label className="text-xs w-40 shrink-0">Max order size (USDC)</Label>
            <Input
              type="number"
              min="1"
              value={maxOrderSize}
              onChange={(e) => setMaxOrderSize(e.target.value)}
              className="w-24 font-mono"
            />
          </div>
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending}>
          Save Settings
        </Button>
      </div>

      {/* Paper trading info */}
      <Card className="border-primary/20 bg-primary/5">
        <CardContent className="py-4 px-5">
          <h3 className="text-sm font-medium mb-2">Rolling BTC 5-Minute Flow</h3>
          <div className="text-xs text-muted-foreground space-y-1.5">
            <p>1. The engine watches the active BTC 5-minute market and looks for a paper entry before expiry.</p>
            <p>2. Open paper positions stay attached to that market id until the candle resolves.</p>
            <p>3. Once the next BTC 5-minute market appears, active strategies can open a fresh paper position there.</p>
            <p>4. Keep sizing conservative while you validate triggers, rollover timing, and fee sensitivity.</p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
