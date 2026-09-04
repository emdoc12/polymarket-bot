import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useState, useEffect } from "react";
import { Shield, AlertTriangle, DollarSign, TrendingDown, Globe, Zap, Layers, KeyRound } from "lucide-react";
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
  const [maxRiskPerTrade, setMaxRiskPerTrade] = useState("8");
  const [takerFeeRate, setTakerFeeRate] = useState("1.0");
  const [drawdownLimit, setDrawdownLimit] = useState("10");
  const [enableDrawdownCircuitBreaker, setEnableDrawdownCircuitBreaker] = useState(false);
  const [enableDynamicSizing, setEnableDynamicSizing] = useState(false);
  const [basePositionPct, setBasePositionPct] = useState("2");
  const [maxPositionPct, setMaxPositionPct] = useState("5");
  const [multiSourceVerify, setMultiSourceVerify] = useState(true);
  const [enableMultiAssetMarkets, setEnableMultiAssetMarkets] = useState(false);
  const [enableOrderbookOptimizer, setEnableOrderbookOptimizer] = useState(true);

  // API key inputs stay empty unless the user is typing a NEW value;
  // stored secrets come back masked as "__secret_set__" and are never shown.
  const [kalshiKeyId, setKalshiKeyId] = useState("");
  const [kalshiPem, setKalshiPem] = useState("");
  const [anthropicKey, setAnthropicKey] = useState("");
  const kalshiPemConfigured = getVal("kalshi_private_key_pem") === "__secret_set__";
  const anthropicKeyConfigured = getVal("anthropic_api_key") === "__secret_set__";

  // Live (real-money) production credentials - fully separate from demo.
  const [prodKeyId, setProdKeyId] = useState("");
  const [prodPem, setProdPem] = useState("");
  const [armPhrase, setArmPhrase] = useState("");
  const prodKeyIdConfigured = getVal("kalshi_prod_api_key_id") === "__secret_set__";
  const prodPemConfigured = getVal("kalshi_prod_private_key_pem") === "__secret_set__";

  const { data: liveStatus } = useQuery<{
    enabled: boolean;
    killSwitch: string;
    killSwitchReason: string | null;
    prodConfigured: boolean;
    armedStrategies: { id: number; name: string; demoTrades: number | null; demoNetPnl: number | null }[];
  }>({
    queryKey: ["/api/live/status"],
    refetchInterval: 30000,
  });

  useEffect(() => {
    if (settings) {
      setMode(getVal("mode", "paper"));
      setPollingInterval(getVal("polling_interval", "5"));
      setMaxDailyTrades(getVal("max_daily_trades", "0"));
      setMaxOrderSize(getVal("max_order_size", "100"));
      setMaxRiskPerTrade((parseFloat(getVal("max_risk_per_trade", "0.08")) * 100).toFixed(0));
      setTakerFeeRate((parseFloat(getVal("taker_fee_rate", "0.072")) * 100).toFixed(1));
      setDrawdownLimit((parseFloat(getVal("drawdown_limit", "0.10")) * 100).toFixed(0));
      setEnableDrawdownCircuitBreaker(getVal("enable_drawdown_circuit_breaker", "false") === "true");
      setEnableDynamicSizing(getVal("enable_dynamic_sizing", "false") === "true");
      setBasePositionPct((parseFloat(getVal("base_position_pct", "0.02")) * 100).toFixed(1));
      setMaxPositionPct((parseFloat(getVal("max_position_pct", "0.05")) * 100).toFixed(1));
      setMultiSourceVerify(getVal("multi_source_verify", "true") === "true");
      setEnableMultiAssetMarkets(getVal("enable_multi_asset_markets", "false") === "true");
      setEnableOrderbookOptimizer(getVal("enable_orderbook_optimizer", "true") === "true");
      setKalshiKeyId(getVal("kalshi_api_key_id"));
    }
  }, [settings]);

  const saveKeysMutation = useMutation({
    mutationFn: async () => {
      const pairs: [string, string][] = [];
      if (kalshiKeyId.trim()) pairs.push(["kalshi_api_key_id", kalshiKeyId.trim()]);
      if (kalshiPem.trim()) pairs.push(["kalshi_private_key_pem", kalshiPem.trim()]);
      if (anthropicKey.trim()) pairs.push(["anthropic_api_key", anthropicKey.trim()]);
      if (pairs.length === 0) throw new Error("Nothing to save - enter at least one key");
      for (const [key, value] of pairs) {
        await apiRequest("POST", "/api/settings", { key, value });
      }
    },
    onSuccess: () => {
      setKalshiPem("");
      setAnthropicKey("");
      queryClient.invalidateQueries({ queryKey: ["/api/settings"] });
      toast({ title: "API keys saved" });
    },
    onError: (e: Error) => {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    },
  });

  const testAnthropicMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/agent-lab/test-key", {});
      return res.json();
    },
    onSuccess: (data: { ok: boolean; model?: string; latencyMs?: number; error?: string }) => {
      if (data.ok) {
        toast({ title: "Anthropic connected", description: `${data.model} replied in ${data.latencyMs}ms` });
      } else {
        toast({ title: "Anthropic test failed", description: data.error, variant: "destructive" });
      }
    },
    onError: (e: Error) => {
      toast({ title: "Anthropic test failed", description: e.message, variant: "destructive" });
    },
  });

  const saveProdKeysMutation = useMutation({
    mutationFn: async () => {
      const pairs: [string, string][] = [];
      if (prodKeyId.trim()) pairs.push(["kalshi_prod_api_key_id", prodKeyId.trim()]);
      if (prodPem.trim()) pairs.push(["kalshi_prod_private_key_pem", prodPem.trim()]);
      if (pairs.length === 0) throw new Error("Nothing to save - enter at least one production key");
      for (const [key, value] of pairs) {
        await apiRequest("POST", "/api/settings", { key, value });
      }
    },
    onSuccess: () => {
      setProdKeyId("");
      setProdPem("");
      queryClient.invalidateQueries({ queryKey: ["/api/settings"] });
      queryClient.invalidateQueries({ queryKey: ["/api/live/status"] });
      toast({ title: "Production keys saved" });
    },
    onError: (e: Error) => {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    },
  });

  const testProdMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/live/self-test", {});
      return res.json();
    },
    onSuccess: (data: { configured: boolean; localSignature: string | null; liveProbe: string | null }) => {
      if (!data.configured) {
        toast({ title: "Live account not configured", description: "Save your production key id and private key first", variant: "destructive" });
      } else if (data.localSignature === "ok" && data.liveProbe?.startsWith("ok")) {
        toast({ title: "Live account connected", description: data.liveProbe });
      } else {
        toast({
          title: "Live connection test failed",
          description: `signature: ${data.localSignature} | live: ${data.liveProbe}`,
          variant: "destructive",
        });
      }
    },
    onError: (e: Error) => {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    },
  });

  const armMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/live/arm", { confirm: armPhrase });
      return res.json();
    },
    onSuccess: () => {
      setArmPhrase("");
      queryClient.invalidateQueries({ queryKey: ["/api/live/status"] });
      toast({ title: "LIVE TRADING ARMED", description: "The live executor is now placing real-money orders." });
    },
    onError: (e: Error) => {
      toast({ title: "Arm failed", description: e.message, variant: "destructive" });
    },
  });

  const disarmMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/live/disarm", {});
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/live/status"] });
      toast({ title: "Live trading disarmed" });
    },
    onError: (e: Error) => {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    },
  });

  const resetKillSwitchMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/live/reset-kill-switch", {});
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/live/status"] });
      toast({ title: "Kill switch cleared", description: "Live trading stays disarmed until you arm it again." });
    },
    onError: (e: Error) => {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    },
  });

  const clearPolymarketMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("POST", "/api/admin/clear-polymarket-data", {});
    },
    onSuccess: () => {
      queryClient.invalidateQueries();
      toast({ title: "Old Polymarket data cleared", description: "Trades, strategies, backtests, and P&L reset. Strategy Lab data untouched." });
    },
    onError: (e: Error) => {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    },
  });

  const testKalshiMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/kalshi/auth/self-test", {});
      return res.json();
    },
    onSuccess: (data: { configured: boolean; localSignature: string | null; liveProbe: string | null }) => {
      if (!data.configured) {
        toast({ title: "Kalshi not configured", description: "Save your key id and private key first", variant: "destructive" });
      } else if (data.localSignature === "ok" && data.liveProbe?.startsWith("ok")) {
        toast({ title: "Kalshi connected", description: data.liveProbe });
      } else {
        toast({
          title: "Kalshi test failed",
          description: `signature: ${data.localSignature} | live: ${data.liveProbe}`,
          variant: "destructive",
        });
      }
    },
    onError: (e: Error) => {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    },
  });

  const saveMutation = useMutation({
    mutationFn: async () => {
      const pairs: [string, string][] = [
        ["mode", mode],
        ["polling_interval", pollingInterval],
        ["max_daily_trades", maxDailyTrades],
        ["max_order_size", maxOrderSize],
        ["max_risk_per_trade", String(parseFloat(maxRiskPerTrade) / 100)],
        ["taker_fee_rate", String(parseFloat(takerFeeRate) / 100)],
        ["drawdown_limit", String(parseFloat(drawdownLimit) / 100)],
        ["enable_drawdown_circuit_breaker", String(enableDrawdownCircuitBreaker)],
        ["enable_dynamic_sizing", String(enableDynamicSizing)],
        ["base_position_pct", String(parseFloat(basePositionPct) / 100)],
        ["max_position_pct", String(parseFloat(maxPositionPct) / 100)],
        ["multi_source_verify", String(multiSourceVerify)],
        ["enable_multi_asset_markets", String(enableMultiAssetMarkets)],
        ["enable_orderbook_optimizer", String(enableOrderbookOptimizer)],
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

      {/* API Keys */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <KeyRound className="w-4 h-4 text-primary" />
            <CardTitle className="text-sm font-medium">API Keys</CardTitle>
          </div>
          <CardDescription className="text-xs">
            Kalshi demo credentials (from demo.kalshi.co → Profile Settings → API Keys) power demo-account
            trading. The Anthropic key powers the Strategy Lab agent team. Keys are stored in the bot's
            local database and never shown again after saving.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-2">
              <Label className="text-xs">Kalshi API Key ID</Label>
              {kalshiKeyId && <Badge variant="secondary" className="text-[10px]">saved</Badge>}
            </div>
            <Input
              value={kalshiKeyId}
              onChange={(e) => setKalshiKeyId(e.target.value)}
              placeholder="e.g. 12345678-abcd-1234-abcd-1234567890ab"
              className="font-mono text-xs"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-2">
              <Label className="text-xs">Kalshi RSA Private Key (PEM)</Label>
              {kalshiPemConfigured && <Badge variant="secondary" className="text-[10px]">configured</Badge>}
            </div>
            <Textarea
              value={kalshiPem}
              onChange={(e) => setKalshiPem(e.target.value)}
              placeholder={kalshiPemConfigured
                ? "A key is already saved. Paste here only to replace it."
                : "-----BEGIN RSA PRIVATE KEY-----\n...paste the whole block Kalshi showed you once...\n-----END RSA PRIVATE KEY-----"}
              rows={4}
              className="font-mono text-xs"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-2">
              <Label className="text-xs">Anthropic API Key</Label>
              {anthropicKeyConfigured && <Badge variant="secondary" className="text-[10px]">configured</Badge>}
            </div>
            <Input
              type="password"
              value={anthropicKey}
              onChange={(e) => setAnthropicKey(e.target.value)}
              placeholder={anthropicKeyConfigured ? "A key is already saved. Paste here only to replace it." : "sk-ant-..."}
              className="font-mono text-xs"
            />
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              onClick={() => saveKeysMutation.mutate()}
              disabled={saveKeysMutation.isPending}
            >
              Save Keys
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => testKalshiMutation.mutate()}
              disabled={testKalshiMutation.isPending}
            >
              {testKalshiMutation.isPending ? "Testing..." : "Test Kalshi Connection"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => testAnthropicMutation.mutate()}
              disabled={testAnthropicMutation.isPending}
            >
              {testAnthropicMutation.isPending ? "Testing..." : "Test Anthropic Connection"}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Live (real-money) trading */}
      <Card className={liveStatus?.enabled ? "border-destructive/50" : "border-amber-500/30"}>
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <AlertTriangle className={`w-4 h-4 ${liveStatus?.enabled ? "text-destructive" : "text-amber-500"}`} />
            <CardTitle className="text-sm font-medium">Live Trading — Real Money</CardTitle>
            {liveStatus?.enabled ? (
              <Badge variant="destructive" className="text-[10px]">ARMED</Badge>
            ) : (
              <Badge variant="secondary" className="text-[10px]">disarmed</Badge>
            )}
            {liveStatus?.killSwitch === "tripped" && (
              <Badge variant="destructive" className="text-[10px]">KILL SWITCH TRIPPED</Badge>
            )}
          </div>
          <CardDescription className="text-xs">
            Production Kalshi credentials (from kalshi.com — not the demo site). Completely separate
            from the demo pipeline, which keeps running either way. Live orders are tiny by design
            ($2 stakes, 2 open max, 20/day max) and only the top demo-proven strategies qualify. A
            cumulative loss past the limit trips the kill switch and disarms automatically.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-2">
              <Label className="text-xs">Production API Key ID</Label>
              {prodKeyIdConfigured && <Badge variant="secondary" className="text-[10px]">configured</Badge>}
            </div>
            <Input
              value={prodKeyId}
              onChange={(e) => setProdKeyId(e.target.value)}
              placeholder={prodKeyIdConfigured ? "A key id is already saved. Paste here only to replace it." : "e.g. 12345678-abcd-1234-abcd-1234567890ab"}
              className="font-mono text-xs"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-2">
              <Label className="text-xs">Production RSA Private Key (PEM)</Label>
              {prodPemConfigured && <Badge variant="secondary" className="text-[10px]">configured</Badge>}
            </div>
            <Textarea
              value={prodPem}
              onChange={(e) => setProdPem(e.target.value)}
              placeholder={prodPemConfigured
                ? "A key is already saved. Paste here only to replace it."
                : "-----BEGIN RSA PRIVATE KEY-----\n...paste the whole block from kalshi.com...\n-----END RSA PRIVATE KEY-----"}
              rows={4}
              className="font-mono text-xs"
            />
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={() => saveProdKeysMutation.mutate()} disabled={saveProdKeysMutation.isPending}>
              Save Production Keys
            </Button>
            <Button size="sm" variant="outline" onClick={() => testProdMutation.mutate()} disabled={testProdMutation.isPending}>
              {testProdMutation.isPending ? "Testing..." : "Test Live Connection"}
            </Button>
          </div>

          <div className="border-t pt-4 space-y-3">
            <div className="text-xs text-muted-foreground">
              {liveStatus?.armedStrategies?.length
                ? <>Allowlist ({liveStatus.armedStrategies.length}): {liveStatus.armedStrategies.map((s) => s.name).join(", ")}</>
                : "No strategies currently qualify for the live allowlist."}
            </div>
            {liveStatus?.killSwitch === "tripped" ? (
              <div className="space-y-2">
                <p className="text-xs text-destructive">
                  Kill switch tripped{liveStatus.killSwitchReason ? `: ${liveStatus.killSwitchReason}` : ""}. Live trading is disabled.
                </p>
                <Button size="sm" variant="outline" onClick={() => resetKillSwitchMutation.mutate()} disabled={resetKillSwitchMutation.isPending}>
                  Reset Kill Switch
                </Button>
              </div>
            ) : liveStatus?.enabled ? (
              <Button size="sm" variant="destructive" onClick={() => disarmMutation.mutate()} disabled={disarmMutation.isPending}>
                Disarm Live Trading
              </Button>
            ) : (
              <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-2">
                <Input
                  value={armPhrase}
                  onChange={(e) => setArmPhrase(e.target.value)}
                  placeholder='Type GO LIVE to confirm'
                  className="font-mono text-xs sm:w-56"
                />
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={() => armMutation.mutate()}
                  disabled={armMutation.isPending || armPhrase !== "GO LIVE" || !liveStatus?.prodConfigured}
                >
                  Arm Live Trading
                </Button>
                {!liveStatus?.prodConfigured && (
                  <span className="text-xs text-muted-foreground">Save and test production keys first.</span>
                )}
              </div>
            )}
          </div>
        </CardContent>
      </Card>

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
            <Switch
              checked={enableDrawdownCircuitBreaker}
              onCheckedChange={setEnableDrawdownCircuitBreaker}
            />
            <Label className="text-xs">
              {enableDrawdownCircuitBreaker ? "Enabled — bot pauses on drawdown" : "Disabled — testing will keep running"}
            </Label>
          </div>
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
            If enabled and today's losses exceed <span className="font-mono font-medium">{drawdownLimit}%</span> of opening balance, all strategies pause automatically.
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

      {/* Adaptive strategy research */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <Zap className="w-4 h-4 text-primary" />
            <CardTitle className="text-sm font-medium">Adaptive Orderbook Optimizer</CardTitle>
          </div>
          <CardDescription className="text-xs">
            Sweep orderbook profiles on each poll and let the manager use the strongest current paper setup.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-3">
            <Switch
              checked={enableOrderbookOptimizer}
              onCheckedChange={setEnableOrderbookOptimizer}
            />
            <Label className="text-xs">
              {enableOrderbookOptimizer ? "Enabled — testing profiles each poll" : "Disabled — using saved strategy settings only"}
            </Label>
          </div>
        </CardContent>
      </Card>

      {/* Market universe */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <Layers className="w-4 h-4 text-primary" />
            <CardTitle className="text-sm font-medium">Market Universe</CardTitle>
          </div>
          <CardDescription className="text-xs">
            Keep the live paper engine focused on BTC while the wider crypto scanner matures.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-3">
            <Switch
              checked={enableMultiAssetMarkets}
              onCheckedChange={setEnableMultiAssetMarkets}
            />
            <Label className="text-xs">
              {enableMultiAssetMarkets ? "Multi-asset scan enabled" : "BTC-only scan enabled"}
            </Label>
          </div>
          <p className="text-xs text-muted-foreground mt-2">
            Leave this off for the current test run. When enabled, the scanner can include ETH, SOL, XRP, BNB, DOGE, and HYPE 5-minute markets.
          </p>
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
          <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-3">
            <Label className="text-xs sm:w-40 sm:shrink-0">Max daily trades</Label>
            <Input
              type="number"
              min="0"
              value={maxDailyTrades}
              onChange={(e) => setMaxDailyTrades(e.target.value)}
              className="w-24 font-mono"
            />
            <span className="text-xs text-muted-foreground">0 = unlimited</span>
          </div>
          <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-3">
            <Label className="text-xs sm:w-40 sm:shrink-0">Max order size (USDC)</Label>
            <Input
              type="number"
              min="1"
              value={maxOrderSize}
              onChange={(e) => setMaxOrderSize(e.target.value)}
              className="w-24 font-mono"
            />
          </div>
          <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-3">
            <Label className="text-xs sm:w-40 sm:shrink-0">Max risk per trade</Label>
            <Input
              type="number"
              min="1"
              max="25"
              value={maxRiskPerTrade}
              onChange={(e) => setMaxRiskPerTrade(e.target.value)}
              className="w-24 font-mono"
            />
            <span className="text-xs text-muted-foreground">% of paper balance</span>
          </div>
          <div className="flex items-center gap-3">
            <Switch
              checked={enableDynamicSizing}
              onCheckedChange={setEnableDynamicSizing}
            />
            <Label className="text-xs">
              {enableDynamicSizing ? "Dynamic sizing enabled" : "Dynamic sizing disabled"}
            </Label>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label className="text-xs">Dynamic base size</Label>
              <div className="flex items-center gap-2">
                <Input
                  type="number"
                  step="0.1"
                  min="0.1"
                  max="25"
                  value={basePositionPct}
                  onChange={(e) => setBasePositionPct(e.target.value)}
                  className="w-24 font-mono"
                />
                <span className="text-xs text-muted-foreground">% balance</span>
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label className="text-xs">Dynamic max size</Label>
              <div className="flex items-center gap-2">
                <Input
                  type="number"
                  step="0.1"
                  min="0.1"
                  max="50"
                  value={maxPositionPct}
                  onChange={(e) => setMaxPositionPct(e.target.value)}
                  className="w-24 font-mono"
                />
                <span className="text-xs text-muted-foreground">% balance</span>
              </div>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Standard sizing clips entries to <span className="font-mono font-medium">{maxRiskPerTrade}%</span>. Dynamic sizing starts at <span className="font-mono font-medium">{basePositionPct}%</span>, scales with streaks, and caps at <span className="font-mono font-medium">{maxPositionPct}%</span>.
          </p>
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending}>
          Save Settings
        </Button>
      </div>

      {/* Danger zone */}
      <Card className="border-destructive/30">
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-destructive" />
            <CardTitle className="text-sm font-medium">Danger Zone</CardTitle>
          </div>
          <CardDescription className="text-xs">
            Permanently delete the Polymarket-era paper data: legacy strategies, their trade log,
            synthetic backtests, and P&L history. Resets the paper balance to $1,000. Strategy Lab
            candidates, cycles, and Kalshi demo trades are NOT affected.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button
            variant="destructive"
            size="sm"
            disabled={clearPolymarketMutation.isPending}
            onClick={() => {
              if (window.confirm("Delete all old Polymarket trades, strategies, and P&L history? This cannot be undone.")) {
                clearPolymarketMutation.mutate();
              }
            }}
          >
            {clearPolymarketMutation.isPending ? "Clearing..." : "Clear Old Polymarket Data"}
          </Button>
        </CardContent>
      </Card>

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
