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
import { Plus, Play, Trash2, Power } from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { Strategy } from "@shared/schema";

export default function Strategies() {
  const [showCreate, setShowCreate] = useState(false);
  const { toast } = useToast();

  const { data: strategies, isLoading } = useQuery<Strategy[]>({
    queryKey: ["/api/strategies"],
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
        description: `Current price: ${(data.currentPrice * 100).toFixed(1)}% | Trigger: ${(data.triggerPrice * 100).toFixed(1)}%`,
      });
    },
    onError: (e: Error) => {
      toast({ title: "Simulation failed", description: e.message, variant: "destructive" });
    },
  });

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

      {!strategies || strategies.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <p className="text-sm text-muted-foreground">
              No strategies yet. Create your first automated trading strategy.
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
                    <div className="flex items-center gap-2">
                      <h3 className="text-sm font-semibold">{s.name}</h3>
                      <Badge variant={s.isActive ? "default" : "secondary"} className="text-[11px]">
                        {s.isActive ? "Active" : "Paused"}
                      </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground mt-1 truncate">
                      {s.marketQuestion || "No market linked"}
                    </p>
                    <div className="flex items-center gap-4 mt-2.5">
                      <span className="text-xs">
                        <span className="text-muted-foreground">Side:</span>{" "}
                        <span className="font-medium">{s.side}</span>
                      </span>
                      <span className="text-xs">
                        <span className="text-muted-foreground">Trigger:</span>{" "}
                        <span className="font-medium font-mono">
                          {s.triggerType === "price_below" ? "< " : "> "}
                          {(s.triggerPrice * 100).toFixed(1)}%
                        </span>
                      </span>
                      <span className="text-xs">
                        <span className="text-muted-foreground">Size:</span>{" "}
                        <span className="font-medium font-mono">${s.orderSize}</span>
                      </span>
                      <span className="text-xs">
                        <span className="text-muted-foreground">Type:</span>{" "}
                        <span className="font-medium">{s.orderType}</span>
                      </span>
                      <span className="text-xs">
                        <span className="text-muted-foreground">Runs:</span>{" "}
                        <span className="font-medium font-mono">{s.totalExecutions}</span>
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => simulateMutation.mutate(s.id)}
                      disabled={simulateMutation.isPending}
                      data-testid={`button-simulate-${s.id}`}
                      title="Simulate"
                    >
                      <Play className="w-3.5 h-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => toggleMutation.mutate({ id: s.id, isActive: !s.isActive })}
                      data-testid={`button-toggle-${s.id}`}
                      title={s.isActive ? "Pause" : "Activate"}
                    >
                      <Power className={`w-3.5 h-3.5 ${s.isActive ? "text-primary" : ""}`} />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-destructive"
                      onClick={() => deleteMutation.mutate(s.id)}
                      data-testid={`button-delete-${s.id}`}
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
    </div>
  );
}

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
                <SelectTrigger data-testid="select-side">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="YES">YES</SelectItem>
                  <SelectItem value="NO">NO</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs">Trigger</Label>
              <Select value={form.triggerType} onValueChange={(v) => setForm({ ...form, triggerType: v })}>
                <SelectTrigger data-testid="select-trigger-type">
                  <SelectValue />
                </SelectTrigger>
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
                type="number"
                step="0.01"
                min="0"
                max="1"
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
                type="number"
                step="1"
                min="1"
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
                <SelectTrigger data-testid="select-order-type">
                  <SelectValue />
                </SelectTrigger>
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
                type="number"
                step="1"
                min="1"
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
