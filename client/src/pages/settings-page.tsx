import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useState, useEffect } from "react";
import { Shield, AlertTriangle } from "lucide-react";
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

  useEffect(() => {
    if (settings) {
      setMode(getVal("mode", "paper"));
      setPollingInterval(getVal("polling_interval", "30"));
      setMaxDailyTrades(getVal("max_daily_trades", "50"));
      setMaxOrderSize(getVal("max_order_size", "100"));
    }
  }, [settings]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      const pairs = [
        ["mode", mode],
        ["polling_interval", pollingInterval],
        ["max_daily_trades", maxDailyTrades],
        ["max_order_size", maxOrderSize],
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
          Configure bot behavior and safety limits
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
            Paper mode simulates trades without executing them on-chain.
            Live mode requires a connected wallet with CLOB API credentials.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Select value={mode} onValueChange={setMode}>
            <SelectTrigger className="w-48" data-testid="select-mode">
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
                Live mode will execute real trades on Polymarket using your wallet.
                Ensure you have CLOB API credentials configured and sufficient USDC balance.
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Polling */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium">Strategy Polling</CardTitle>
          <CardDescription className="text-xs">
            How frequently the bot checks market prices against your strategy triggers.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-3">
            <Label htmlFor="polling" className="text-xs shrink-0">Check every</Label>
            <Input
              id="polling"
              data-testid="input-polling-interval"
              type="number"
              min="5"
              max="300"
              value={pollingInterval}
              onChange={(e) => setPollingInterval(e.target.value)}
              className="w-24 font-mono"
            />
            <span className="text-xs text-muted-foreground">seconds</span>
          </div>
        </CardContent>
      </Card>

      {/* Safety Limits */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium">Safety Limits</CardTitle>
          <CardDescription className="text-xs">
            Circuit breakers to prevent runaway trading.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-3">
            <Label htmlFor="maxTrades" className="text-xs w-40 shrink-0">Max daily trades</Label>
            <Input
              id="maxTrades"
              data-testid="input-max-daily-trades"
              type="number"
              min="1"
              value={maxDailyTrades}
              onChange={(e) => setMaxDailyTrades(e.target.value)}
              className="w-24 font-mono"
            />
          </div>
          <div className="flex items-center gap-3">
            <Label htmlFor="maxSize" className="text-xs w-40 shrink-0">Max order size (USDC)</Label>
            <Input
              id="maxSize"
              data-testid="input-max-order-size"
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
        <Button
          onClick={() => saveMutation.mutate()}
          disabled={saveMutation.isPending}
          data-testid="button-save-settings"
        >
          Save Settings
        </Button>
      </div>

      {/* Info Box */}
      <Card className="border-primary/20 bg-primary/5">
        <CardContent className="py-4 px-5">
          <h3 className="text-sm font-medium mb-2">Connecting to Polymarket</h3>
          <div className="text-xs text-muted-foreground space-y-2">
            <p>
              To enable live trading, you need a Polygon wallet with USDC and Polymarket CLOB API credentials.
              The bot uses the py-clob-client or @polymarket/clob-client SDK to interact with the CLOB.
            </p>
            <p>
              1. Export your private key from your wallet<br />
              2. Derive L2 API credentials using the SDK<br />
              3. Set environment variables: POLY_PRIVATE_KEY, POLY_API_KEY, POLY_API_SECRET, POLY_PASSPHRASE<br />
              4. Switch to Live mode above
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
