import type { Express } from "express";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
// The SDK's zod helper needs zod v4 types; the rest of the app (drizzle-zod)
// stays on the v3 entrypoint. zod >= 3.25 ships both from one install.
import { z } from "zod/v4";
import { storage } from "./storage";
import {
  clampSpec,
  evaluateSpecOnData,
  evaluateSpecSample,
  fetchSettledMarketData,
  specHash,
  type KalshiStrategySpec,
  type SettledMarketData,
} from "./kalshi";
import {
  clampPerpSpec,
  evaluatePerpSpecOnCandles,
  evaluatePerpSpecSample,
  fetchPerpCandleHistory,
  perpSpecHash,
  type PerpCandle,
  type PerpStrategySpec,
} from "./kalshi-perps";
import type { CandidateStrategy } from "@shared/schema";

// The Strategy Lab: a PM (Opus) directing a team of specialist agents (Haiku)
// that invent, mutate, and stress-test parameterized Kalshi strategy specs.
// Every proposal is evaluated against REAL settled markets with a chronological
// train/holdout split before the PM decides its fate. Mirrors the jedi-algo
// trading-desk pattern (Opus PM + Haiku workers) adapted to prediction markets.

const DEFAULT_PM_MODEL = "claude-opus-5";
const DEFAULT_WORKER_MODEL = "claude-haiku-4-5";

// Numeric ranges are enforced by clampSpec, not the schema — structured
// outputs don't support min/max constraints, and clamping still tests a
// slightly-out-of-range idea instead of discarding it.
const SpecProposalSchema = z.object({
  name: z.string(),
  series: z.enum(["KXBTC15M", "KXETH15M"]),
  sideRule: z.enum(["momentum", "fade", "always_yes", "always_no", "trend_follow", "trend_fade"]),
  entrySecondsBeforeClose: z.number(),
  minEntryPrice: z.number(),
  maxEntryPrice: z.number(),
  trendLookbackMinutes: z.number(),
  minSignal: z.number(),
  rationale: z.string(),
});

const WorkerOutputSchema = z.object({
  proposals: z.array(SpecProposalSchema),
  notes: z.string(),
});

const PerpSpecProposalSchema = z.object({
  name: z.string(),
  market: z.enum(["KXBTCPERP1", "KXETHPERP1"]),
  direction: z.enum(["trend_follow", "trend_fade"]),
  lookbackMinutes: z.number(),
  entryThresholdPct: z.number(),
  takeProfitPct: z.number(),
  stopLossPct: z.number(),
  maxHoldMinutes: z.number(),
  rationale: z.string(),
});

const PerpWorkerOutputSchema = z.object({
  proposals: z.array(PerpSpecProposalSchema),
  notes: z.string(),
});

const PmOutputSchema = z.object({
  decisions: z.array(z.object({
    candidateId: z.number(),
    action: z.enum(["promote", "keep_testing", "reject"]),
    reason: z.string(),
  })),
  focus: z.string(),
  commentary: z.string(),
});

const SPEC_SPACE_DOC = `Strategy spec fields (all trades are $10 stakes on Kalshi crypto up/down markets, quadratic fee ~= 0.07*P*(1-P) per contract, taker side):
- series: "KXBTC15M" (BTC 15-min up/down) or "KXETH15M" (ETH 15-min up/down)
- sideRule: "momentum" (back the currently favored side), "fade" (back the underdog), "always_yes", "always_no", "trend_follow" (back the direction the market price moved over the lookback), "trend_fade" (against it)
- entrySecondsBeforeClose: 60-840 (when to enter, seconds before the window closes)
- minEntryPrice / maxEntryPrice: 0.03-0.97 (only enter if the executable price of the chosen side is inside this band)
- trendLookbackMinutes: 1-10 (trend rules only)
- minSignal: 0-0.45 (minimum |price-0.5| for momentum/fade; minimum |price move| for trend rules; 0 = no filter)
Known result: naive momentum at T-300s loses money despite ~60% win rate because favorites are priced rich. The edge, if any, lives in timing, price bands, and signal thresholds.

Output discipline: keep every rationale, note, and reason to one or two sentences. Structured output that exceeds the token limit is truncated and the whole response is lost - compact and complete always beats detailed and cut off.`;

type WorkerRole = {
  key: string;
  system: string;
  buildTask: (context: string) => string;
};

const WORKER_ROLES: WorkerRole[] = [
  {
    key: "explorer",
    system: `You are the Explorer on a quant research desk for crypto prediction markets. Your job is to propose NOVEL strategy specs in regions of the search space the team has not tried yet. Diversity beats depth: vary sideRule, entry timing, and price bands. Avoid near-duplicates of the leaderboard.\n\n${SPEC_SPACE_DOC}`,
    buildTask: (context) => `${context}\n\nPropose exactly 3 novel specs with distinct hypotheses. For each, one-sentence rationale stating the market inefficiency it targets.`,
  },
  {
    key: "optimizer",
    system: `You are the Optimizer on a quant research desk for crypto prediction markets. Your job is to take the most promising existing candidates and propose refined mutations: adjust one or two parameters at a time to sharpen the edge. If nothing on the leaderboard is profitable on holdout, mutate toward whatever direction the train/holdout gap suggests.\n\n${SPEC_SPACE_DOC}`,
    buildTask: (context) => `${context}\n\nPropose exactly 3 mutations of the strongest candidates (or best near-misses). For each, name the parent idea and what you changed and why.`,
  },
  {
    key: "skeptic",
    system: `You are the Skeptic on a quant research desk for crypto prediction markets. Your job is to stress-test the leaders: propose specs that check whether an apparent edge is real or overfit (same rule on the other series, shifted timing, tighter signal). In your notes, call out any leaderboard result that looks like curve-fitting (small samples, train >> holdout).\n\n${SPEC_SPACE_DOC}`,
    buildTask: (context) => `${context}\n\nPropose exactly 2 robustness-check specs targeting the current leaders, and use the notes field for overfitting concerns the PM should hear.`,
  },
];

const PERP_SPEC_DOC = `Perp strategy spec fields (Kalshi perpetual futures, $50 notional per trade, taker fee ~0.12% of notional each side, long/short via continuous 1-min candles; funding is NOT modeled so holds are capped at 3h):
- market: "KXBTCPERP1" (BTC perp, ~BTC/10000 price scale) or "KXETHPERP1" (ETH perp)
- direction: "trend_follow" (enter with the move) or "trend_fade" (against it)
- lookbackMinutes: 3-120 (window for measuring the move)
- entryThresholdPct: 0.02-2 (minimum |%| move over the lookback to trigger an entry)
- takeProfitPct / stopLossPct: 0.05-3 (% from entry; longs enter at the ask, exit at the bid - the spread is a real cost your TP must clear)
- maxHoldMinutes: 5-180 (time stop)
Both round-trip fees (~0.24% total) and the bid/ask spread come out of every trade - edges below ~0.3%/trade are noise.

Output discipline: keep every rationale, note, and reason to one or two sentences.`;

const PERP_WORKER_ROLES: { key: string; system: string; buildTask: (context: string) => string }[] = [
  {
    key: "perp_explorer",
    system: `You are the Perps Explorer on a quant research desk. Propose NOVEL perpetual-futures specs in unexplored regions: vary market, direction, lookback horizons and threshold/exit geometry. Diversity beats depth.\n\n${PERP_SPEC_DOC}`,
    buildTask: (context) => `${context}\n\nPropose exactly 3 novel perp specs with distinct hypotheses. One-sentence rationale each.`,
  },
  {
    key: "perp_optimizer",
    system: `You are the Perps Optimizer on a quant research desk. Mutate the most promising existing perp candidates: adjust one or two parameters to sharpen the edge, guided by train/holdout gaps. If nothing is profitable yet, probe the opposite direction or different exit geometry of near-misses.\n\n${PERP_SPEC_DOC}`,
    buildTask: (context) => `${context}\n\nPropose exactly 3 mutations of the strongest perp candidates (or best near-misses), naming the parent and the change.`,
  },
];

const PM_SYSTEM = `You are the Portfolio Manager of a quant research desk hunting for a real, fee-surviving edge on Kalshi crypto prediction markets. Your team of specialist agents proposes strategy specs; each gets a discovery backtest (train/holdout split at proposal time) and then accumulates WALK-FORWARD results: every cycle, surviving candidates are re-scored on markets that settled after they were proposed. Walk-forward ("live") evidence is the truth - it cannot be overfit.

Decision rules:
- promote: only when live (walk-forward) results show positive net P&L on >= 15 live trades AND the discovery results point the same way. Be stingy - promotion means this spec is a candidate for real demo-account trading.
- reject: live net P&L clearly negative on >= 15 live trades, or discovery results hopeless on a decent sample, or a duplicate-in-spirit of a rejected idea. Keep the testing pool focused: if it grows past ~30 candidates, aggressively reject the weakest so evidence concentrates on the contenders.
- keep_testing: genuinely promising but still under-sampled on live evidence.
The desk runs TWO strategy kinds, reviewed together:
- kind "binary": event-contract specs on 15-min up/down markets (see the binary spec doc below).
- kind "perp": perpetual-futures long/short specs. ${PERP_SPEC_DOC.split("\n")[0]} Same promotion discipline applies: >= 15 profitable live (walk-forward) trades with discovery agreement.

Weigh the Skeptic's overfitting notes seriously. Set a specific, actionable research focus for the next cycle.

Output limits: one sentence per decision reason. Keep commentary to one focused paragraph and the research focus to a few sentences - your full reasoning happens internally, the output is the executive summary. A response that exceeds the token limit is truncated and every decision in it is lost.

${SPEC_SPACE_DOC}`;

// Settings-page key wins over the container env var; the cached client is
// keyed by the value so pasting a new key takes effect without a restart.
let anthropic: Anthropic | null = null;
let anthropicClientKey: string | null = null;
export function getAnthropicApiKey(): string | null {
  return storage.getSetting("anthropic_api_key") || process.env.ANTHROPIC_API_KEY || null;
}
function getAnthropicClient() {
  const apiKey = getAnthropicApiKey();
  if (!apiKey) return null;
  if (!anthropic || anthropicClientKey !== apiKey) {
    anthropic = new Anthropic({ apiKey });
    anthropicClientKey = apiKey;
  }
  return anthropic;
}

function ensureAgentLabDefaults() {
  if (!storage.getSetting("agent_lab_enabled")) storage.setSetting("agent_lab_enabled", "false");
  if (!storage.getSetting("agent_lab_perps_enabled")) storage.setSetting("agent_lab_perps_enabled", "true");
  if (!storage.getSetting("perp_lab_hours")) storage.setSetting("perp_lab_hours", "72");
  if (!storage.getSetting("agent_lab_interval_minutes")) storage.setSetting("agent_lab_interval_minutes", "30");
  if (!storage.getSetting("agent_lab_max_candidates_per_cycle")) storage.setSetting("agent_lab_max_candidates_per_cycle", "8");
  if (!storage.getSetting("agent_lab_max_cycles_per_day")) storage.setSetting("agent_lab_max_cycles_per_day", "24");
  if (!storage.getSetting("agent_lab_markets_lookback")) storage.setSetting("agent_lab_markets_lookback", "80");
  if (!storage.getSetting("agent_lab_pm_model")) storage.setSetting("agent_lab_pm_model", DEFAULT_PM_MODEL);
  if (!storage.getSetting("agent_lab_worker_model")) storage.setSetting("agent_lab_worker_model", DEFAULT_WORKER_MODEL);
}

function describeCandidate(candidate: CandidateStrategy) {
  return {
    id: candidate.id,
    name: candidate.name,
    kind: candidate.kind,
    status: candidate.status,
    createdBy: candidate.createdBy,
    generation: candidate.generation,
    spec: JSON.parse(candidate.spec),
    train: { trades: candidate.trainTrades, wins: candidate.trainWins, netPnl: candidate.trainNetPnl },
    holdout: { trades: candidate.holdoutTrades, wins: candidate.holdoutWins, netPnl: candidate.holdoutNetPnl },
    live: { trades: candidate.liveTrades, wins: candidate.liveWins, netPnl: candidate.liveNetPnl },
    demo: { trades: candidate.demoTrades, wins: candidate.demoWins, netPnl: candidate.demoNetPnl },
    rationale: candidate.rationale,
    pmNotes: candidate.pmNotes,
  };
}

function buildResearchContext() {
  const all = storage.getCandidateStrategies();
  const leaderboard = [...all]
    .filter((c) => c.holdoutNetPnl != null)
    .sort((a, b) => (b.holdoutNetPnl ?? -Infinity) - (a.holdoutNetPnl ?? -Infinity))
    .slice(0, 12);
  const recentRuns = storage.getAgentLabRuns(3).map((run) => ({
    ranAt: run.ranAt,
    focus: run.focus,
    commentary: run.pmCommentary,
    tested: run.testedCount,
    promoted: run.promotedCount,
  }));
  const lastFocus = recentRuns[0]?.focus ?? "No prior focus - first cycle.";
  return {
    contextText: [
      `Current research focus from PM: ${lastFocus}`,
      `Total candidates ever tested: ${all.length} (promoted: ${all.filter((c) => c.status === "promoted").length}, rejected: ${all.filter((c) => c.status === "rejected").length})`,
      `Leaderboard (top by holdout net P&L, $10 stakes):`,
      JSON.stringify(leaderboard.map(describeCandidate), null, 1),
      `Recent cycles:`,
      JSON.stringify(recentRuns, null, 1),
    ].join("\n"),
  };
}

type CycleResult = {
  runId: number;
  proposals: number;
  tested: number;
  promoted: number;
  rejected: number;
  focus: string | null;
  commentary: string | null;
  candidates: ReturnType<typeof describeCandidate>[];
};

let cycleInFlight = false;

export async function runAgentLabCycle(trigger: "manual" | "scheduled"): Promise<CycleResult> {
  const client = getAnthropicClient();
  if (!client) {
    throw new Error("Anthropic API key is not configured - paste it in Settings (API Keys) to enable the agent lab");
  }
  if (cycleInFlight) {
    throw new Error("A research cycle is already running");
  }

  cycleInFlight = true;
  const run = storage.createAgentLabRun({
    ranAt: new Date().toISOString(),
    trigger,
    proposalsCount: 0,
    testedCount: 0,
    promotedCount: 0,
    rejectedCount: 0,
    focus: null,
    pmCommentary: null,
    error: null,
  });

  try {
    ensureAgentLabDefaults();
    const workerModel = storage.getSetting("agent_lab_worker_model") || DEFAULT_WORKER_MODEL;
    const pmModel = storage.getSetting("agent_lab_pm_model") || DEFAULT_PM_MODEL;
    const maxCandidates = Math.min(16, Math.max(1, parseInt(storage.getSetting("agent_lab_max_candidates_per_cycle") || "8", 10)));
    const lookback = Math.min(150, Math.max(20, parseInt(storage.getSetting("agent_lab_markets_lookback") || "80", 10)));

    const { contextText } = buildResearchContext();

    // 1. Specialist agents propose in parallel (structured outputs -> validated
    // JSON). Each worker is individually fault-isolated: a truncated or failed
    // response costs that worker's proposals, never the whole cycle.
    const workerResults = await Promise.all(WORKER_ROLES.map(async (role) => {
      try {
        const response = await client.messages.parse({
          model: workerModel,
          max_tokens: 6000,
          system: role.system,
          messages: [{ role: "user", content: role.buildTask(contextText) }],
          output_config: { format: zodOutputFormat(WorkerOutputSchema) },
        });
        if (response.stop_reason === "refusal" || !response.parsed_output) {
          return { role: role.key, proposals: [], notes: `(${role.key} returned no usable output)` };
        }
        return { role: role.key, proposals: response.parsed_output.proposals, notes: response.parsed_output.notes };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`${new Date().toISOString()} [error] [agent-lab] worker ${role.key} failed: ${message}`);
        return { role: role.key, proposals: [], notes: `(${role.key} call failed: ${message.slice(0, 120)})` };
      }
    }));

    // 1b. Perps desk specialists (same fault isolation, perp grammar).
    const perpsEnabled = storage.getSetting("agent_lab_perps_enabled") !== "false";
    const perpWorkerResults = !perpsEnabled ? [] : await Promise.all(PERP_WORKER_ROLES.map(async (role) => {
      try {
        const response = await client.messages.parse({
          model: workerModel,
          max_tokens: 6000,
          system: role.system,
          messages: [{ role: "user", content: role.buildTask(contextText) }],
          output_config: { format: zodOutputFormat(PerpWorkerOutputSchema) },
        });
        if (response.stop_reason === "refusal" || !response.parsed_output) {
          return { role: role.key, proposals: [], notes: `(${role.key} returned no usable output)` };
        }
        return { role: role.key, proposals: response.parsed_output.proposals, notes: response.parsed_output.notes };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`${new Date().toISOString()} [error] [agent-lab] worker ${role.key} failed: ${message}`);
        return { role: role.key, proposals: [], notes: `(${role.key} call failed: ${message.slice(0, 120)})` };
      }
    }));

    // 2. Clamp, dedupe against everything ever tested, cap per cycle.
    const skepticNotes = [...workerResults, ...perpWorkerResults].map((w) => `${w.role}: ${w.notes}`).join("\n");
    const generation = storage.getAgentLabRuns(1)[0]?.id ?? 1;
    const fresh: { candidate: CandidateStrategy; spec: KalshiStrategySpec }[] = [];
    let proposalCount = 0;
    for (const worker of workerResults) {
      for (const proposal of worker.proposals) {
        proposalCount += 1;
        if (fresh.length >= maxCandidates) continue;
        const spec = clampSpec(proposal);
        const hash = specHash(spec);
        if (storage.getCandidateBySpecHash(hash)) continue;
        const candidate = storage.createCandidateStrategy({
          name: spec.name,
          spec: JSON.stringify(spec),
          specHash: hash,
          status: "testing",
          createdBy: worker.role,
          rationale: proposal.rationale,
          generation,
          createdAt: new Date().toISOString(),
        });
        fresh.push({ candidate, spec });
      }
    }

    const freshPerp: { candidate: CandidateStrategy; spec: PerpStrategySpec }[] = [];
    for (const worker of perpWorkerResults) {
      for (const proposal of worker.proposals) {
        proposalCount += 1;
        if (freshPerp.length >= maxCandidates) continue;
        const spec = clampPerpSpec(proposal);
        const hash = perpSpecHash(spec);
        if (storage.getCandidateBySpecHash(hash)) continue;
        const candidate = storage.createCandidateStrategy({
          name: spec.name,
          kind: "perp",
          spec: JSON.stringify(spec),
          specHash: hash,
          status: "testing",
          createdBy: worker.role,
          rationale: proposal.rationale,
          generation,
          createdAt: new Date().toISOString(),
        });
        freshPerp.push({ candidate, spec });
      }
    }

    // 3. Backtest: fetch market data once per series, evaluate all specs in memory.
    // Series set covers fresh proposals AND surviving candidates (walk-forward).
    // Promoted candidates keep accumulating live evidence too — they're the ones
    // whose ongoing performance matters most, and a lucky promotion needs to be
    // caught by continued out-of-sample scoring, not enshrined.
    const survivorsAll = [
      ...storage.getCandidateStrategies("testing"),
      ...storage.getCandidateStrategies("promoted"),
    ].filter((c) => c.lastTestedAt != null);
    const survivors = survivorsAll.filter((c) => c.kind !== "perp");
    const perpSurvivors = survivorsAll.filter((c) => c.kind === "perp");
    const seriesNeeded = [...new Set([
      ...fresh.map((f) => f.spec.series),
      ...survivors.map((c) => (JSON.parse(c.spec) as KalshiStrategySpec).series),
    ])];
    const dataBySeries = new Map<string, SettledMarketData[]>();
    for (const series of seriesNeeded) {
      dataBySeries.set(series, await fetchSettledMarketData(series, lookback));
    }

    // 3a. Walk-forward: score each survivor on markets settled since its last
    // evaluation. Evidence accumulates cycle over cycle - this is the sample
    // that promotion decisions rest on, and it cannot be curve-fit.
    let walkForwardUpdates = 0;
    for (const candidate of survivors) {
      const spec = clampSpec(JSON.parse(candidate.spec));
      const data = dataBySeries.get(spec.series) ?? [];
      const sinceMs = candidate.lastEvalCloseMs ?? Date.parse(candidate.createdAt);
      const newMarkets = data.filter((entry) => entry.closeMs > sinceMs);
      if (newMarkets.length === 0) continue;
      const sample = evaluateSpecSample(spec, newMarkets);
      storage.updateCandidateStrategy(candidate.id, {
        liveTrades: (candidate.liveTrades ?? 0) + sample.trades,
        liveWins: (candidate.liveWins ?? 0) + sample.wins,
        liveNetPnl: (candidate.liveNetPnl ?? 0) + sample.netPnl,
        lastEvalCloseMs: Math.max(...newMarkets.map((entry) => entry.closeMs)),
      });
      walkForwardUpdates += 1;
    }
    const testedResults: { candidate: CandidateStrategy; result: ReturnType<typeof evaluateSpecOnData> }[] = [];
    for (const { candidate, spec } of fresh) {
      const data = dataBySeries.get(spec.series) ?? [];
      if (data.length < 10) continue;
      const result = evaluateSpecOnData(spec, data);
      storage.updateCandidateStrategy(candidate.id, {
        trainTrades: result.train.trades,
        trainWins: result.train.wins,
        trainNetPnl: result.train.netPnl,
        holdoutTrades: result.holdout.trades,
        holdoutWins: result.holdout.wins,
        holdoutNetPnl: result.holdout.netPnl,
        lastTestedAt: new Date().toISOString(),
      });
      testedResults.push({ candidate, result });
    }

    // 3b. Perps desk: candle history fetched once per market, then discovery
    // for fresh perp specs and walk-forward accumulation for survivors.
    const perpHours = Math.min(168, Math.max(24, parseInt(storage.getSetting("perp_lab_hours") || "72", 10)));
    const perpMarketsNeeded = [...new Set([
      ...freshPerp.map((f) => f.spec.market),
      ...perpSurvivors.map((c) => clampPerpSpec(JSON.parse(c.spec)).market),
    ])];
    const candlesByMarket = new Map<string, PerpCandle[]>();
    for (const market of perpMarketsNeeded) {
      try {
        candlesByMarket.set(market, await fetchPerpCandleHistory(market, perpHours));
      } catch (err) {
        console.error(`${new Date().toISOString()} [error] [agent-lab] perp candle fetch failed for ${market}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    for (const candidate of perpSurvivors) {
      const spec = clampPerpSpec(JSON.parse(candidate.spec));
      const candles = candlesByMarket.get(spec.market) ?? [];
      if (candles.length === 0) continue;
      const sinceSec = Math.floor((candidate.lastEvalCloseMs ?? Date.parse(candidate.createdAt)) / 1000);
      const lastTs = candles[candles.length - 1]?.end_period_ts ?? 0;
      if (lastTs <= sinceSec) continue;
      const sample = evaluatePerpSpecSample(spec, candles, sinceSec);
      storage.updateCandidateStrategy(candidate.id, {
        liveTrades: (candidate.liveTrades ?? 0) + sample.trades,
        liveWins: (candidate.liveWins ?? 0) + sample.wins,
        liveNetPnl: (candidate.liveNetPnl ?? 0) + sample.netPnl,
        lastEvalCloseMs: lastTs * 1000,
      });
      walkForwardUpdates += 1;
    }

    for (const { candidate, spec } of freshPerp) {
      const candles = candlesByMarket.get(spec.market) ?? [];
      if (candles.length < 120) continue;
      const result = evaluatePerpSpecOnCandles(spec, candles);
      storage.updateCandidateStrategy(candidate.id, {
        trainTrades: result.train.trades,
        trainWins: result.train.wins,
        trainNetPnl: result.train.netPnl,
        holdoutTrades: result.holdout.trades,
        holdoutWins: result.holdout.wins,
        holdoutNetPnl: result.holdout.netPnl,
        lastTestedAt: new Date().toISOString(),
        // Walk-forward starts where the discovery window ended.
        lastEvalCloseMs: (candles[candles.length - 1]?.end_period_ts ?? 0) * 1000,
      });
      testedResults.push({ candidate, result: result as any });
    }

    // 4. PM reviews everything under test, strongest live evidence first so the
    // contenders are always inside the review window.
    const underReview = storage.getCandidateStrategies("testing")
      .filter((c) => c.lastTestedAt != null)
      .sort((a, b) => (b.liveNetPnl ?? -Infinity) - (a.liveNetPnl ?? -Infinity))
      .slice(0, 40);
    let promoted = 0;
    let rejected = 0;
    let focus: string | null = null;
    let commentary: string | null = null;

    if (underReview.length > 0) {
      // Fault-isolated like the workers: a failed PM call (truncation, API
      // error) leaves candidates in testing — walk-forward results from step
      // 3a are already saved either way.
      try {
        const pmResponse = await client.messages.parse({
          model: pmModel,
          max_tokens: 12000,
          system: PM_SYSTEM,
          messages: [{
            role: "user",
            content: [
              contextText,
              `\nSpecialist notes from this cycle:\n${skepticNotes}`,
              `\nCandidates currently under review (decide each by candidateId):`,
              JSON.stringify(underReview.map(describeCandidate), null, 1),
            ].join("\n"),
          }],
          output_config: { format: zodOutputFormat(PmOutputSchema) },
        });

        if (pmResponse.stop_reason !== "refusal" && pmResponse.parsed_output) {
          focus = pmResponse.parsed_output.focus;
          commentary = pmResponse.parsed_output.commentary;
          const validIds = new Set(underReview.map((c) => c.id));
          for (const decision of pmResponse.parsed_output.decisions) {
            if (!validIds.has(decision.candidateId)) continue;
            if (decision.action === "promote") {
              storage.updateCandidateStrategy(decision.candidateId, { status: "promoted", pmNotes: decision.reason });
              promoted += 1;
            } else if (decision.action === "reject") {
              storage.updateCandidateStrategy(decision.candidateId, { status: "rejected", pmNotes: decision.reason });
              rejected += 1;
            } else {
              storage.updateCandidateStrategy(decision.candidateId, { pmNotes: decision.reason });
            }
          }
        } else {
          commentary = "PM response was unusable this cycle; candidates keep testing.";
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`${new Date().toISOString()} [error] [agent-lab] PM call failed: ${message}`);
        commentary = `PM call failed this cycle (${message.slice(0, 120)}); candidates keep testing.`;
      }
    }

    // 5. Deterministic hygiene, independent of the PM: a candidate that has
    // proven itself a loser on accumulated walk-forward evidence is culled
    // even if it never made it into the PM's review window.
    for (const candidate of storage.getCandidateStrategies("testing")) {
      if ((candidate.liveTrades ?? 0) >= 25 && (candidate.liveNetPnl ?? 0) < 0) {
        storage.updateCandidateStrategy(candidate.id, {
          status: "rejected",
          pmNotes: `auto-rejected: ${candidate.liveNetPnl?.toFixed(2)} net over ${candidate.liveTrades} walk-forward trades`,
        });
        rejected += 1;
      }
    }

    // Promotion is revocable: if a promoted strategy's cumulative walk-forward
    // record turns negative, it drops back into the testing pool where the PM
    // re-judges it (and the auto-cull above ends it if it keeps losing).
    for (const candidate of storage.getCandidateStrategies("promoted")) {
      if ((candidate.liveTrades ?? 0) >= 25 && (candidate.liveNetPnl ?? 0) < 0) {
        storage.updateCandidateStrategy(candidate.id, {
          status: "testing",
          pmNotes: `demoted: walk-forward record turned negative (${candidate.liveNetPnl?.toFixed(2)} over ${candidate.liveTrades} trades)`,
        });
      }
    }

    storage.updateAgentLabRun(run.id, {
      proposalsCount: proposalCount,
      testedCount: testedResults.length,
      promotedCount: promoted,
      rejectedCount: rejected,
      focus,
      pmCommentary: commentary,
    });

    return {
      runId: run.id,
      proposals: proposalCount,
      tested: testedResults.length,
      promoted,
      rejected,
      focus,
      commentary,
      candidates: testedResults.map((t) => {
        const updated = storage.getCandidateStrategies().find((c) => c.id === t.candidate.id);
        return describeCandidate(updated ?? t.candidate);
      }),
    };
  } catch (err) {
    storage.updateAgentLabRun(run.id, { error: err instanceof Error ? err.message : String(err) });
    throw err;
  } finally {
    cycleInFlight = false;
  }
}

function cyclesToday() {
  const today = new Date().toISOString().slice(0, 10);
  return storage.getAgentLabRuns(200).filter((run) => run.ranAt.startsWith(today)).length;
}

let labTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleLab() {
  const intervalMin = Math.max(5, parseInt(storage.getSetting("agent_lab_interval_minutes") || "30", 10));
  labTimer = setTimeout(async () => {
    try {
      const enabled = storage.getSetting("agent_lab_enabled") === "true";
      const maxPerDay = Math.max(1, parseInt(storage.getSetting("agent_lab_max_cycles_per_day") || "24", 10));
      if (enabled && getAnthropicClient() && !cycleInFlight && cyclesToday() < maxPerDay) {
        await runAgentLabCycle("scheduled");
      }
    } catch (err) {
      console.error(`${new Date().toISOString()} [error] [agent-lab] scheduled cycle failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    scheduleLab();
  }, intervalMin * 60 * 1000);
}

export function registerAgentLabRoutes(app: Express) {
  ensureAgentLabDefaults();
  if (!labTimer) scheduleLab();

  app.get("/api/agent-lab/status", (_req, res) => {
    res.json({
      apiKeyConfigured: Boolean(getAnthropicApiKey()),
      enabled: storage.getSetting("agent_lab_enabled") === "true",
      intervalMinutes: parseInt(storage.getSetting("agent_lab_interval_minutes") || "30", 10),
      maxCandidatesPerCycle: parseInt(storage.getSetting("agent_lab_max_candidates_per_cycle") || "8", 10),
      maxCyclesPerDay: parseInt(storage.getSetting("agent_lab_max_cycles_per_day") || "24", 10),
      cyclesToday: cyclesToday(),
      cycleInFlight,
      pmModel: storage.getSetting("agent_lab_pm_model") || DEFAULT_PM_MODEL,
      workerModel: storage.getSetting("agent_lab_worker_model") || DEFAULT_WORKER_MODEL,
      candidates: {
        testing: storage.getCandidateStrategies("testing").length,
        promoted: storage.getCandidateStrategies("promoted").length,
        rejected: storage.getCandidateStrategies("rejected").length,
      },
    });
  });

  // Cheap end-to-end key check: one tiny Haiku call. ~fractions of a cent.
  app.post("/api/agent-lab/test-key", async (_req, res) => {
    const client = getAnthropicClient();
    if (!client) {
      res.status(400).json({ ok: false, error: "No Anthropic API key configured - paste one in Settings first" });
      return;
    }
    try {
      const started = Date.now();
      const response = await client.messages.create({
        model: storage.getSetting("agent_lab_worker_model") || DEFAULT_WORKER_MODEL,
        max_tokens: 16,
        messages: [{ role: "user", content: "Reply with the single word: OK" }],
      });
      const text = response.content.find((block) => block.type === "text");
      res.json({
        ok: true,
        model: response.model,
        latencyMs: Date.now() - started,
        reply: text && text.type === "text" ? text.text.slice(0, 40) : "",
      });
    } catch (e: any) {
      const message = e?.status === 401
        ? "Anthropic rejected the key (401) - check for typos or a revoked key"
        : e?.message || String(e);
      res.status(502).json({ ok: false, error: message });
    }
  });

  app.post("/api/agent-lab/run", async (_req, res) => {
    try {
      res.json(await runAgentLabCycle("manual"));
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/agent-lab/candidates", (req, res) => {
    const status = req.query.status as string | undefined;
    const candidates = storage.getCandidateStrategies(status).map(describeCandidate);
    res.json({ candidates });
  });

  app.get("/api/agent-lab/runs", (_req, res) => {
    res.json({ runs: storage.getAgentLabRuns(30) });
  });
}
