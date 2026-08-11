import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { BrainCircuit, FlaskConical, Play, Users } from "lucide-react";

type LabStatus = {
  apiKeyConfigured: boolean;
  enabled: boolean;
  intervalMinutes: number;
  maxCandidatesPerCycle: number;
  maxCyclesPerDay: number;
  cyclesToday: number;
  cycleInFlight: boolean;
  pmModel: string;
  workerModel: string;
  candidates: { testing: number; promoted: number; rejected: number };
};

type Candidate = {
  id: number;
  name: string;
  status: string;
  createdBy: string;
  spec: {
    series: string;
    sideRule: string;
    entrySecondsBeforeClose: number;
    minEntryPrice: number;
    maxEntryPrice: number;
    trendLookbackMinutes: number;
    minSignal: number;
  };
  train: { trades: number | null; wins: number | null; netPnl: number | null };
  holdout: { trades: number | null; wins: number | null; netPnl: number | null };
  rationale: string | null;
  pmNotes: string | null;
};

type LabRun = {
  id: number;
  ranAt: string;
  trigger: string;
  proposalsCount: number;
  testedCount: number;
  promotedCount: number;
  rejectedCount: number;
  focus: string | null;
  pmCommentary: string | null;
  error: string | null;
};

function PnlText({ value }: { value: number | null }) {
  if (value == null) return <span className="text-muted-foreground">—</span>;
  return (
    <span className={cn("font-mono", value > 0 ? "text-profit" : value < 0 ? "text-loss" : "text-muted-foreground")}>
      {value >= 0 ? "+" : ""}{value.toFixed(2)}
    </span>
  );
}

function SampleCell({ sample }: { sample: Candidate["train"] }) {
  if (sample.trades == null) return <span className="text-xs text-muted-foreground">not tested</span>;
  const winRate = sample.trades > 0 ? ((sample.wins ?? 0) / sample.trades) * 100 : 0;
  return (
    <div className="text-xs">
      <PnlText value={sample.netPnl} />
      <span className="text-muted-foreground ml-1.5">
        {sample.trades}t · {winRate.toFixed(0)}%
      </span>
    </div>
  );
}

function statusBadge(status: string) {
  if (status === "promoted") return <Badge className="bg-profit/15 text-profit border-profit/20 text-[10px]">promoted</Badge>;
  if (status === "rejected") return <Badge variant="outline" className="text-muted-foreground text-[10px]">rejected</Badge>;
  return <Badge variant="secondary" className="text-[10px]">testing</Badge>;
}

function describeSpec(spec: Candidate["spec"]) {
  const pieces = [
    spec.series.replace("KX", "").replace("15M", " 15m"),
    spec.sideRule.replace("_", " "),
    `T-${spec.entrySecondsBeforeClose}s`,
    `band ${(spec.minEntryPrice * 100).toFixed(0)}-${(spec.maxEntryPrice * 100).toFixed(0)}¢`,
  ];
  if (spec.minSignal > 0) pieces.push(`signal ≥ ${(spec.minSignal * 100).toFixed(1)}%`);
  if (spec.sideRule.startsWith("trend")) pieces.push(`${spec.trendLookbackMinutes}m lookback`);
  return pieces.join(" · ");
}

export default function AgentLabPage() {
  const { toast } = useToast();

  const { data: status } = useQuery<LabStatus>({
    queryKey: ["/api/agent-lab/status"],
    refetchInterval: 10000,
  });
  const { data: candidatesData } = useQuery<{ candidates: Candidate[] }>({
    queryKey: ["/api/agent-lab/candidates"],
    refetchInterval: 15000,
  });
  const { data: runsData } = useQuery<{ runs: LabRun[] }>({
    queryKey: ["/api/agent-lab/runs"],
    refetchInterval: 15000,
  });

  const refreshAll = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/agent-lab/status"] });
    queryClient.invalidateQueries({ queryKey: ["/api/agent-lab/candidates"] });
    queryClient.invalidateQueries({ queryKey: ["/api/agent-lab/runs"] });
  };

  const runCycleMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/agent-lab/run", {});
      return res.json();
    },
    onSuccess: (data: { tested: number; promoted: number; rejected: number; commentary: string | null }) => {
      refreshAll();
      toast({
        title: `Cycle complete — ${data.tested} tested, ${data.promoted} promoted, ${data.rejected} rejected`,
        description: data.commentary?.slice(0, 200) ?? undefined,
      });
    },
    onError: (e: Error) => {
      refreshAll();
      toast({ title: "Cycle failed", description: e.message, variant: "destructive" });
    },
  });

  const toggleEnabledMutation = useMutation({
    mutationFn: async (enabled: boolean) => {
      await apiRequest("POST", "/api/settings", { key: "agent_lab_enabled", value: String(enabled) });
    },
    onSuccess: () => refreshAll(),
    onError: (e: Error) => {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    },
  });

  const candidates = candidatesData?.candidates ?? [];
  const leaderboard = [...candidates]
    .filter((c) => c.holdout.netPnl != null)
    .sort((a, b) => (b.holdout.netPnl ?? -Infinity) - (a.holdout.netPnl ?? -Infinity));
  const runs = runsData?.runs ?? [];
  const running = status?.cycleInFlight || runCycleMutation.isPending;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold tracking-tight flex items-center gap-2">
            <BrainCircuit className="w-5 h-5 text-primary" /> Strategy Lab
          </h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            {status ? `${status.pmModel} PM directing ${status.workerModel} specialists` : "Loading…"}
          </p>
        </div>
        <Button onClick={() => runCycleMutation.mutate()} disabled={running || !status?.apiKeyConfigured}>
          <Play className="w-4 h-4 mr-1.5" />
          {running ? "Cycle running… (1-3 min)" : "Run Research Cycle"}
        </Button>
      </div>

      {status && !status.apiKeyConfigured && (
        <Card className="border-destructive/30 bg-destructive/5">
          <CardContent className="py-3 px-4 text-xs text-destructive">
            No Anthropic API key configured. Paste one in Settings → API Keys, then come back here.
          </CardContent>
        </Card>
      )}

      {/* Status row */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Card>
          <CardContent className="py-3 px-4">
            <p className="text-xs text-muted-foreground flex items-center gap-1"><Users className="w-3 h-3" /> Autonomous research</p>
            <div className="flex items-center gap-2 mt-1.5">
              <Switch
                checked={status?.enabled ?? false}
                onCheckedChange={(checked) => toggleEnabledMutation.mutate(checked)}
                disabled={!status?.apiKeyConfigured}
              />
              <Label className="text-xs">
                {status?.enabled ? `every ${status.intervalMinutes}m` : "off"}
              </Label>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="py-3 px-4">
            <p className="text-xs text-muted-foreground">Cycles today</p>
            <p className="text-lg font-semibold font-mono mt-0.5">
              {status ? `${status.cyclesToday}/${status.maxCyclesPerDay}` : "—"}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="py-3 px-4">
            <p className="text-xs text-muted-foreground">Testing / Promoted</p>
            <p className="text-lg font-semibold font-mono mt-0.5">
              {status ? `${status.candidates.testing} / ` : "—"}
              {status && <span className="text-profit">{status.candidates.promoted}</span>}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="py-3 px-4">
            <p className="text-xs text-muted-foreground">Rejected</p>
            <p className="text-lg font-semibold font-mono mt-0.5 text-muted-foreground">
              {status?.candidates.rejected ?? "—"}
            </p>
          </CardContent>
        </Card>
      </div>

      <Tabs defaultValue="leaderboard">
        <TabsList>
          <TabsTrigger value="leaderboard" className="text-xs">Leaderboard</TabsTrigger>
          <TabsTrigger value="runs" className="text-xs">Cycle History</TabsTrigger>
        </TabsList>

        <TabsContent value="leaderboard" className="mt-3">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <FlaskConical className="w-4 h-4 text-primary" /> Candidates by holdout P&L
              </CardTitle>
              <CardDescription className="text-xs">
                $10 stakes on real settled markets. Train = older half, Holdout = newer half — an edge is only
                real if it survives the holdout sample.
              </CardDescription>
            </CardHeader>
            <CardContent className="px-0 pb-0">
              {leaderboard.length === 0 ? (
                <p className="text-xs text-muted-foreground px-5 pb-4">
                  Nothing tested yet — run a research cycle to let the team propose its first strategies.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-[11px] text-muted-foreground border-b border-border">
                        <th className="text-left font-medium px-5 py-2">Strategy</th>
                        <th className="text-left font-medium px-3 py-2">Status</th>
                        <th className="text-left font-medium px-3 py-2">Train</th>
                        <th className="text-left font-medium px-3 py-2">Holdout</th>
                        <th className="text-left font-medium px-3 py-2 hidden lg:table-cell">PM notes</th>
                      </tr>
                    </thead>
                    <tbody>
                      {leaderboard.map((candidate) => (
                        <tr key={candidate.id} className="border-b border-border/50 align-top">
                          <td className="px-5 py-2.5">
                            <p className="text-xs font-medium">{candidate.name}</p>
                            <p className="text-[11px] text-muted-foreground">{describeSpec(candidate.spec)}</p>
                            <p className="text-[11px] text-muted-foreground/70">by {candidate.createdBy}</p>
                          </td>
                          <td className="px-3 py-2.5">{statusBadge(candidate.status)}</td>
                          <td className="px-3 py-2.5"><SampleCell sample={candidate.train} /></td>
                          <td className="px-3 py-2.5"><SampleCell sample={candidate.holdout} /></td>
                          <td className="px-3 py-2.5 hidden lg:table-cell">
                            <p className="text-[11px] text-muted-foreground max-w-xs">
                              {candidate.pmNotes ?? candidate.rationale ?? ""}
                            </p>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="runs" className="mt-3 space-y-3">
          {runs.length === 0 ? (
            <Card><CardContent className="py-4 px-5 text-xs text-muted-foreground">No cycles yet.</CardContent></Card>
          ) : (
            runs.map((run) => (
              <Card key={run.id} className={cn(run.error && "border-destructive/30")}>
                <CardContent className="py-3 px-4">
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="font-mono text-muted-foreground">{new Date(run.ranAt).toLocaleString()}</span>
                    <Badge variant="outline" className="text-[10px]">{run.trigger}</Badge>
                    <span className="text-muted-foreground">
                      {run.proposalsCount} proposed · {run.testedCount} tested ·{" "}
                      <span className="text-profit">{run.promotedCount} promoted</span> · {run.rejectedCount} rejected
                    </span>
                  </div>
                  {run.error && <p className="text-xs text-destructive mt-1.5">{run.error}</p>}
                  {run.pmCommentary && <p className="text-xs mt-1.5">{run.pmCommentary}</p>}
                  {run.focus && (
                    <p className="text-[11px] text-muted-foreground mt-1">
                      <span className="font-medium">Next focus:</span> {run.focus}
                    </p>
                  )}
                </CardContent>
              </Card>
            ))
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
