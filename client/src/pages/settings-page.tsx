import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
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
      setPollingInterval(getVal("polling_interval", "30"));
      setMaxDailyTrades(getVal("max_daily_trades", "50"));
      setMaxOrderSize(getVal("max_order_size", "100"));
      setTakerFeeRate((parseFloat(getVal("taker_fee_rate", "0.01")) * 100).toFixed(1));
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
            <CardTitle className="text-sm font-medium">Trading Mode</CardTitle>
          </div>
          <CardDescription className="text-xs">
            Paper mode simulates trades without real execution.
            Live mode requires a connected Polygon wallet with CLOB API credentials.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Select value={mode} onValueChange={setMode}>
            <SelectTrigger className="w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="paper">Paper Trading</SelectItem>
              <SelectItem value="live">Live Trading</SelectItem>
            </SelectContent>
          </Select>
          {mode === "live" && (
            <div className="flex items-start gap-2 mt-3 p-3 rounded-md bg-destructive/10 border border-destructive/20">
              <AlertTriangle className="w-4 h-4 text-destructive shrink-0 mt-0.5" />
              <p className="text-xs text-destructive">
                Live mode executes real trades on Polymarket using your wallet.
                Ensure CLOB API credentials are set and USDC balance is sufficient.
              </p>
            </div>
          )}
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
            Taker fees are deducted from P&L on every trade close (entry + exit).
            Polymarket charges 1-2% taker fee. Target edges must exceed fees.
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
            <span className="text-xs text-muted-foreground">% per side</span>
          </div>
          <p className="text-xs text-muted-foreground mt-2">
            Effective round-trip cost: <span className="font-mono font-medium">{(parseFloat(takerFeeRate || "0") * 2).toFixed(1)}%</span> per trade.
            Strategies target <span className="font-mono">&gt;3%</span> net edge.
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
            Cross-check Polymarket prices against CryptoCompare/Chainlink before executing.
            Reduces false signals from stale feeds.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-3">
            <Switch
              checked={multiSourceVerify}
              onCheckedChange={setMultiSourceVerify}
            />
            <Label className="text-xs">
              {multiSourceVerify ? "Enabled — prices verified against CryptoCompare" : "Disabled — using Polymarket feed only"}
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

      {/* Live trading info */}
      <Card className="border-primary/20 bg-primary/5">
        <CardContent className="py-4 px-5">
          <h3 className="text-sm font-medium mb-2">Connecting to Polymarket (Live Mode)</h3>
          <div className="text-xs text-muted-foreground space-y-1.5">
            <p>1. Export your private key from your Polygon wallet</p>
            <p>2. Derive L2 API credentials via <span className="font-mono">py-clob-client</span> or <span className="font-mono">@polymarket/clob-client</span></p>
            <p>3. Set environment variables on the container:</p>
            <code className="block bg-background/60 rounded px-3 py-2 font-mono text-[11px] mt-1 leading-relaxed">
              POLY_PRIVATE_KEY=0x...<br />
              POLY_API_KEY=...<br />
              POLY_API_SECRET=...<br />
              POLY_PASSPHRASE=...
            </code>
            <p className="mt-1">4. Switch to Live mode above and save.</p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
