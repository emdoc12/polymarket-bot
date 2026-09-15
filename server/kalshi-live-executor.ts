import type { Express } from "express";
import { storage } from "./storage";
import {
  clampSpec,
  getKalshiMarket,
  getKalshiMarkets,
  hourEt,
  hourInWindow,
  kalshiTradingFee,
  valueModelProbUp,
  type KalshiMarket,
  type KalshiStrategySpec,
} from "./kalshi";
import { decideLiveEntry } from "./kalshi-executor";
import { kalshiProdStream } from "./kalshi-ws";
import {
  cancelKalshiOrderEnv,
  ensureShardFundsEnv,
  getKalshiAuthStatusEnv,
  getKalshiBalanceEnv,
  getKalshiOrderEnv,
  getMarketExchangeIndexEnv,
  placeKalshiOrderEnv,
  runKalshiAuthSelfTestEnv,
} from "./kalshi-trading";
import type { CandidateStrategy } from "@shared/schema";

// Phase 3: the LIVE executor - real money on the production Kalshi exchange.
// A third, fully parallel pipeline: demo research and demo execution continue
// unchanged; this one has its own credentials, its own ledger (live_trades),
// and deliberately harsher rails:
//
//  - tiny stakes (live_order_size, default $2)
//  - hard caps: live_max_open_trades (2), live_max_trades_per_day (20)
//  - automatic allowlist: only promoted BINARY strategies with the strongest
//    REAL demo execution records (>= live_min_demo_trades settled demo fills,
//    positive demo P&L), top live_top_n by demo net P&L
//  - kill switch: cumulative live net loss beyond live_max_total_loss trips
//    live_kill_switch (auto-disables the executor); only a human can reset it
//  - no dry-run concept here - that is what the demo pipeline is for
//
// Market data and entry logic are the SAME code the demo executor runs
// (production quotes were always the signal source); only the order path
// points at the production account.

const ENTRY_TOLERANCE_SEC = 75;

function liveEnabled() {
  return storage.getSetting("live_executor_enabled") === "true"
    && storage.getSetting("live_kill_switch") !== "tripped";
}

function ensureLiveDefaults() {
  if (!storage.getSetting("live_executor_enabled")) storage.setSetting("live_executor_enabled", "false");
  if (!storage.getSetting("live_order_size")) storage.setSetting("live_order_size", "2");
  if (!storage.getSetting("live_max_open_trades")) storage.setSetting("live_max_open_trades", "2");
  if (!storage.getSetting("live_max_trades_per_day")) storage.setSetting("live_max_trades_per_day", "20");
  if (!storage.getSetting("live_max_total_loss")) storage.setSetting("live_max_total_loss", "25");
  if (!storage.getSetting("live_top_n")) storage.setSetting("live_top_n", "3");
  if (!storage.getSetting("live_min_demo_trades")) storage.setSetting("live_min_demo_trades", "20");
  if (!storage.getSetting("live_kill_switch")) storage.setSetting("live_kill_switch", "ok");
  if (!storage.getSetting("live_poll_seconds")) storage.setSetting("live_poll_seconds", "15");
  if (!storage.getSetting("live_max_entry_price")) storage.setSetting("live_max_entry_price", "0.80");
  if (!storage.getSetting("live_min_audition_trades")) storage.setSetting("live_min_audition_trades", "15");
  if (!storage.getSetting("live_trading_hours_et")) storage.setSetting("live_trading_hours_et", "0-24");
  if (!storage.getSetting("live_auto_stake")) storage.setSetting("live_auto_stake", "true");
  if (!storage.getSetting("live_cooldown_losses")) storage.setSetting("live_cooldown_losses", "3");
  if (!storage.getSetting("live_cooldown_minutes")) storage.setSetting("live_cooldown_minutes", "45");
  if (!storage.getSetting("live_stake_fraction")) storage.setSetting("live_stake_fraction", "0.04");
  if (!storage.getSetting("live_max_order_size")) storage.setSetting("live_max_order_size", "10");
  if (!storage.getSetting("live_transport")) storage.setSetting("live_transport", "rest");
  if (!storage.getSetting("live_salvage_enabled")) storage.setSetting("live_salvage_enabled", "true");
  if (!storage.getSetting("live_salvage_edge")) storage.setSetting("live_salvage_edge", "0.06");
  if (!storage.getSetting("live_salvage_max_model_value")) storage.setSetting("live_salvage_max_model_value", "0.35");
  if (!storage.getSetting("live_recency_bench_dollars")) storage.setSetting("live_recency_bench_dollars", "6");
  if (!storage.getSetting("live_recency_bench_trades")) storage.setSetting("live_recency_bench_trades", "15");
  if (!storage.getSetting("live_trailing_soft")) storage.setSetting("live_trailing_soft", "12");
  if (!storage.getSetting("live_trailing_hard")) storage.setSetting("live_trailing_hard", "20");
  if (!storage.getSetting("live_trailing_pause_hours")) storage.setSetting("live_trailing_pause_hours", "6");
  // How long a maker (passive) entry rests in the book before it expires and
  // the executor falls back to a taker order. Only matters for specs that set
  // makerJoinCents > 0; taker specs are unaffected.
  if (!storage.getSetting("live_maker_timeout_sec")) storage.setSetting("live_maker_timeout_sec", "20");
}

function makerTimeoutSec(): number {
  const raw = parseInt(storage.getSetting("live_maker_timeout_sec") || "20", 10);
  return Number.isFinite(raw) ? Math.min(120, Math.max(5, raw)) : 20;
}

// Account-level trailing stop (user directive 2026-09-13: "an agentic desk
// should know to back off when losing - a trailing stop on overall P&L").
// Tracks the high-water mark of realized live P&L:
//   drawdown >= soft ($12): DEFENSIVE - stakes halved.
//   drawdown >= hard ($20): PAUSED - no new entries for pause_hours, then
//   the high-water mark REBASES to the current P&L so trading restarts with
//   a fresh trail (a pause that required recovery-to-resume would deadlock,
//   since a paused book can't recover). Salvage and settlement always run.
// State persists in settings as JSON so restarts don't forget the peak.
type TrailingState = { hwm: number; pausedUntil: string | null };
function readTrailingState(): TrailingState {
  try {
    const raw = storage.getSetting("live_trailing_state");
    if (raw) return JSON.parse(raw) as TrailingState;
  } catch { /* re-init below */ }
  // First run: seed the high-water mark from the full ledger's path maximum.
  const settled = storage.getLiveTrades(10000)
    .filter((t) => t.netPnl != null && t.settledAt != null)
    .sort((a, b) => (a.settledAt! < b.settledAt! ? -1 : 1));
  let cum = 0, hwm = 0;
  for (const t of settled) { cum += t.netPnl!; hwm = Math.max(hwm, cum); }
  const state = { hwm, pausedUntil: null };
  storage.setSetting("live_trailing_state", JSON.stringify(state));
  return state;
}

export function trailingStatus(): { hwm: number; pnl: number; drawdown: number; mode: "normal" | "defensive" | "paused"; pausedUntil: string | null } {
  const soft = Math.max(0, parseFloat(storage.getSetting("live_trailing_soft") || "12"));
  const hard = Math.max(0, parseFloat(storage.getSetting("live_trailing_hard") || "20"));
  const pauseHours = Math.max(1, parseFloat(storage.getSetting("live_trailing_pause_hours") || "6"));
  const state = readTrailingState();
  const pnl = liveTotalNetPnl();

  if (state.pausedUntil) {
    if (Date.now() < new Date(state.pausedUntil).getTime()) {
      return { hwm: state.hwm, pnl, drawdown: state.hwm - pnl, mode: "paused", pausedUntil: state.pausedUntil };
    }
    // Pause expired: rebase the trail to here and resume.
    const rebased = { hwm: pnl, pausedUntil: null };
    storage.setSetting("live_trailing_state", JSON.stringify(rebased));
    console.log(`${new Date().toISOString()} [live-executor] trailing stop pause ended - HWM rebased to ${pnl.toFixed(2)}`);
    return { hwm: pnl, pnl, drawdown: 0, mode: "normal", pausedUntil: null };
  }

  if (pnl > state.hwm) {
    storage.setSetting("live_trailing_state", JSON.stringify({ hwm: pnl, pausedUntil: null }));
    return { hwm: pnl, pnl, drawdown: 0, mode: "normal", pausedUntil: null };
  }
  const drawdown = state.hwm - pnl;
  if (hard > 0 && drawdown >= hard) {
    const pausedUntil = new Date(Date.now() + pauseHours * 3600_000).toISOString();
    storage.setSetting("live_trailing_state", JSON.stringify({ hwm: state.hwm, pausedUntil }));
    console.log(`${new Date().toISOString()} [live-executor] TRAILING STOP: drawdown ${drawdown.toFixed(2)} from peak ${state.hwm.toFixed(2)} - entries paused ${pauseHours}h`);
    return { hwm: state.hwm, pnl, drawdown, mode: "paused", pausedUntil };
  }
  if (soft > 0 && drawdown >= soft) {
    return { hwm: state.hwm, pnl, drawdown, mode: "defensive", pausedUntil: null };
  }
  return { hwm: state.hwm, pnl, drawdown, mode: "normal", pausedUntil: null };
}

// Order transport. "stream": decisions price off the live websocket book
// (~2s evaluation, quotes ms-fresh) and orders fire only after the book
// confirms enough resting depth for our size - built after replaying all
// 140 REST misses showed 73% would-have-won (~$31 left on the table).
// Orders themselves always go over REST (Kalshi has no WS order channel).
// If the stream is down or stale, entries fall back to REST quotes and are
// tagged accordingly - the executor never goes blind.
export function liveTransport(): "rest" | "stream" {
  return storage.getSetting("live_transport") === "stream" ? "stream" : "rest";
}

// Active-window discovery cache: stream mode ticks every ~2s and must not
// hammer the REST markets endpoint (close times only change once per window).
const activeMarketCache = new Map<string, { at: number; active: { market: KalshiMarket; closeMs: number } | null }>();
async function activeMarketFor(series: string, nowMs: number): Promise<{ market: KalshiMarket; closeMs: number } | null> {
  const cached = activeMarketCache.get(series);
  if (cached && nowMs - cached.at < 12_000 && (cached.active == null || cached.active.closeMs > nowMs)) {
    return cached.active;
  }
  let active: { market: KalshiMarket; closeMs: number } | null = null;
  try {
    const { markets } = await getKalshiMarkets({ seriesTicker: series, status: "open", limit: 10 });
    active = markets
      .map((market) => ({ market, closeMs: market.close_time ? new Date(market.close_time).getTime() : NaN }))
      .filter((entry) => Number.isFinite(entry.closeMs) && entry.closeMs > nowMs)
      .sort((a, b) => a.closeMs - b.closeMs)[0] ?? null;
  } catch {
    active = cached?.active ?? null;
  }
  activeMarketCache.set(series, { at: nowMs, active });
  return active;
}

// Bankroll-proportional stakes: 4% of (free cash + open-position cost),
// floored to whole dollars, between live_order_size (floor) and
// live_max_order_size (cap). $50->$2, $75->$3, $100->$4, $125->$5 ... and it
// steps DOWN in drawdowns, protecting the kill-switch distance. Balance is
// cached ~60s; any fetch failure falls back to the floor stake.
let bankrollCache: { at: number; dollars: number } | null = null;
export async function computeLiveStake(): Promise<number> {
  const floorStake = Math.max(0.5, parseFloat(storage.getSetting("live_order_size") || "2"));
  if (storage.getSetting("live_auto_stake") !== "true") return floorStake;
  const cap = Math.max(floorStake, parseFloat(storage.getSetting("live_max_order_size") || "10"));
  const fraction = Math.min(0.15, Math.max(0.01, parseFloat(storage.getSetting("live_stake_fraction") || "0.04")));
  try {
    if (!bankrollCache || Date.now() - bankrollCache.at > 60_000) {
      const balance = await getKalshiBalanceEnv("prod");
      const freeCash = typeof balance?.balance === "number" ? balance.balance / 100 : NaN;
      if (!Number.isFinite(freeCash)) return floorStake;
      const openCost = storage.getUnsettledLiveTrades().reduce((sum, t) => sum + t.cost, 0);
      bankrollCache = { at: Date.now(), dollars: freeCash + openCost };
    }
    const base = Math.min(cap, Math.max(floorStake, Math.floor(bankrollCache.dollars * fraction)));
    // Defensive mode (trailing drawdown past the soft line): halve stakes.
    if (trailingStatus().mode === "defensive") return Math.max(1, Math.floor(base / 2));
    return base;
  } catch {
    return floorStake;
  }
}

// Loss cool-down: live forensics show losses cluster (P(loss | prev loss)
// ~50% vs ~30% after a win) - chop regimes persist across windows and the
// trade right after a losing streak is roughly a coin flip, which is
// negative EV at these entry prices. After N consecutive losses, hold fire
// for M minutes from the last loss's settlement. live_cooldown_losses=0
// disables. Shared with the shadow mirror so the A/B keeps identical rules.
export function computeCooldown(
  settled: { netPnl: number | null; settledAt: string | null }[],
): { active: boolean; consecutiveLosses: number; untilMs: number | null } {
  const lossesNeeded = Math.max(0, parseInt(storage.getSetting("live_cooldown_losses") || "3", 10));
  const minutes = Math.max(1, parseInt(storage.getSetting("live_cooldown_minutes") || "45", 10));
  if (lossesNeeded === 0) return { active: false, consecutiveLosses: 0, untilMs: null };
  const rows = settled
    .filter((t) => t.netPnl != null && t.settledAt != null)
    .sort((a, b) => (b.settledAt! < a.settledAt! ? -1 : 1));
  let streak = 0;
  for (const t of rows) {
    if ((t.netPnl ?? 0) <= 0) streak += 1;
    else break;
  }
  if (streak < lossesNeeded || rows.length === 0) return { active: false, consecutiveLosses: streak, untilMs: null };
  const untilMs = new Date(rows[0].settledAt!).getTime() + minutes * 60_000;
  return { active: Date.now() < untilMs, consecutiveLosses: streak, untilMs };
}

export function liveCooldown() {
  return computeCooldown(storage.getLiveTrades(30));
}

// Executor-level trading-hours curfew ("8-24" = only 8am-midnight ET;
// "0-24" = always). A manual rail layered on top of per-spec hour bands -
// the stopgap while the lab learns hour windows from data. Applies to live
// and to every shadow row so the shadow record stays predictive of live.
export function withinLiveTradingHours(nowMs = Date.now()): boolean {
  const raw = storage.getSetting("live_trading_hours_et") || "0-24";
  const match = raw.match(/^(\d{1,2})\s*-\s*(\d{1,2})$/);
  if (!match) return true;
  const start = Math.min(24, Math.max(0, parseInt(match[1], 10)));
  const end = Math.min(24, Math.max(0, parseInt(match[2], 10)));
  return hourInWindow(hourEt(nowMs), start, end);
}

// Live-only price guards. The floor mirrors the demo executor's fillability
// floor; the ceiling exists because early live evidence shows extreme
// favorites (>80c) underperforming their demo win rates on real books, and
// at those prices there is almost no cushion for being wrong. The demo
// pipeline keeps trading the full band so the evidence keeps accumulating.
export function passesLivePriceGuards(price: number): boolean {
  const minFillable = parseFloat(storage.getSetting("executor_min_fillable_price") || "0.30");
  if (Number.isFinite(minFillable) && price < minFillable) return false;
  const maxEntry = parseFloat(storage.getSetting("live_max_entry_price") || "0.80");
  if (Number.isFinite(maxEntry) && maxEntry > 0 && price > maxEntry) return false;
  return true;
}

// Only actual fills count toward the daily cap - unfilled IOC orders and
// failed placements cost nothing and shouldn't throttle later entries.
function liveTradesToday() {
  const today = new Date().toISOString().slice(0, 10);
  return storage.getLiveTrades(500)
    .filter((t) => t.placedAt.startsWith(today) && t.status !== "failed" && t.status !== "unfilled").length;
}

function liveTotalNetPnl() {
  return storage.getLiveTrades(10000)
    .filter((t) => t.netPnl != null)
    .reduce((sum, t) => sum + (t.netPnl ?? 0), 0);
}

// The allowlist is earned, not configured - and it is earned on the venue
// live money actually trades. Evidence hierarchy per promoted binary spec:
//
//   1. REAL live record: >= 25 settled live trades below -$10 net benches a
//      strategy outright (only a positive prod audition can bring it back).
//   2. PROD AUDITION: >= live_min_audition_trades settled would-fill shadow
//      trades on real production orderbooks with positive net P&L qualifies,
//      and audition-qualified specs always outrank demo-only ones.
//   3. DEMO record (transitional fallback while audition data accumulates):
//      >= live_min_demo_trades settled demo fills with positive net P&L.
// Memoized 5s: this runs from 1-2s ticks in two executors and rebuilds
// recent-trade maps; per-second recomputation was an event-loop hog.
let armedCache: { at: number; armed: CandidateStrategy[] } | null = null;
export function getLiveArmedStrategies(): CandidateStrategy[] {
  if (armedCache && Date.now() - armedCache.at < 5_000) return armedCache.armed;
  const armedResult = computeLiveArmedStrategies();
  armedCache = { at: Date.now(), armed: armedResult };
  return armedResult;
}

function computeLiveArmedStrategies(): CandidateStrategy[] {
  // live_top_n = 0 means UNLIMITED: every qualified strategy trades. Safe
  // because risk is bounded per trade (bankroll-fraction stakes), per window
  // (one position), per moment (max open), and per strategy (the live bench
  // rule evicts anything ~$10 negative) - breadth is self-pruning.
  const topN = Math.max(0, parseInt(storage.getSetting("live_top_n") || "3", 10));
  const minDemo = Math.max(1, parseInt(storage.getSetting("live_min_demo_trades") || "20", 10));
  const minAudition = Math.max(1, parseInt(storage.getSetting("live_min_audition_trades") || "15", 10));

  const auditionByCandidate = new Map<number, { settled: number; netPnl: number }>();
  for (const t of storage.getWsShadowTrades(10000)) {
    if (t.candidateId == null || t.netPnl == null) continue;
    const s = auditionByCandidate.get(t.candidateId) ?? { settled: 0, netPnl: 0 };
    s.settled += 1;
    s.netPnl += t.netPnl;
    auditionByCandidate.set(t.candidateId, s);
  }
  const liveByCandidate = new Map<number, { settled: number; netPnl: number }>();
  for (const t of storage.getLiveTrades(10000)) {
    if (t.candidateId == null || t.netPnl == null) continue;
    const s = liveByCandidate.get(t.candidateId) ?? { settled: 0, netPnl: 0 };
    s.settled += 1;
    s.netPnl += t.netPnl;
    liveByCandidate.set(t.candidateId, s);
  }

  // Recency bench (user directive 2026-09-13: "don't keep doing the same
  // thing when it's losing time after time - don't give back all the gains"):
  // a strategy whose LAST-N settled record is decisively net-negative sits
  // out, regardless of a positive lifetime. Self-healing: the rolling window
  // re-admits it the moment recent results recover. Judged on the freshest
  // real-book evidence available (live trades when the sample is adequate,
  // else the strategy's own audition rows). NET P&L only - never win counts,
  // or the 45%-win low-band engines would be culled for breathing.
  const benchN = Math.max(5, parseInt(storage.getSetting("live_recency_bench_trades") || "15", 10));
  const benchDollars = Math.max(0, parseFloat(storage.getSetting("live_recency_bench_dollars") || "6"));
  const recentLive = new Map<number, number[]>();
  for (const t of storage.getLiveTrades(2000)) {
    if (t.candidateId == null || t.netPnl == null) continue;
    const arr = recentLive.get(t.candidateId) ?? [];
    if (arr.length < benchN) arr.push(t.netPnl);
    recentLive.set(t.candidateId, arr);
  }
  const recentAudition = new Map<number, number[]>();
  for (const t of storage.getWsShadowTrades(5000)) {
    if (t.candidateId == null || t.netPnl == null) continue;
    const arr = recentAudition.get(t.candidateId) ?? [];
    if (arr.length < benchN) arr.push(t.netPnl);
    recentAudition.set(t.candidateId, arr);
  }
  const recencyBenchedNames: string[] = [];
  const isRecencyBenched = (c: CandidateStrategy): boolean => {
    if (benchDollars === 0) return false;
    const liveArr = recentLive.get(c.id) ?? [];
    const audArr = recentAudition.get(c.id) ?? [];
    const arr = liveArr.length >= 8 ? liveArr : audArr;
    if (arr.length < 8) return false; // not enough fresh evidence to convict
    const net = arr.reduce((a, b) => a + b, 0);
    return net <= -benchDollars;
  };

  const armed = storage.getCandidateStrategies("promoted")
    .filter((c) => c.kind !== "perp")
    .map((c) => {
      const audition = auditionByCandidate.get(c.id);
      const live = liveByCandidate.get(c.id);
      const auditionOk = audition != null && audition.settled >= minAudition && audition.netPnl > 0;
      const demoOk = (c.demoTrades ?? 0) >= minDemo && (c.demoNetPnl ?? 0) > 0;
      const liveBenched = live != null && live.settled >= 25 && live.netPnl < -10;
      const recencyBenched = isRecencyBenched(c);
      if (recencyBenched && (auditionOk || demoOk)) recencyBenchedNames.push(c.name);
      const eligible = (auditionOk || demoOk) && (!liveBenched || auditionOk) && !recencyBenched;
      // Audition-qualified specs sort above demo-only ones regardless of size.
      const score = auditionOk ? 1_000_000 + audition!.netPnl : (c.demoNetPnl ?? 0);
      return { c, eligible, score };
    })
    .filter((entry) => entry.eligible)
    .sort((a, b) => b.score - a.score)
    .slice(0, topN === 0 ? undefined : topN)
    .map((entry) => entry.c);
  lastRecencyBenched = recencyBenchedNames;
  return armed;
}

// Visibility: who is currently sitting out on the recency bench.
let lastRecencyBenched: string[] = [];
export function getRecencyBenched(): string[] {
  return lastRecencyBenched;
}

function tripKillSwitch(reason: string) {
  storage.setSetting("live_kill_switch", "tripped");
  storage.setSetting("live_kill_switch_reason", reason);
  storage.setSetting("live_executor_enabled", "false");
  console.error(`${new Date().toISOString()} [error] [live-executor] KILL SWITCH TRIPPED: ${reason}`);
}

async function settleLiveTrades() {
  for (const trade of storage.getUnsettledLiveTrades()) {
    const closeMs = new Date(trade.marketCloseAt).getTime();
    if (!Number.isFinite(closeMs) || Date.now() - closeMs < 2 * 60 * 1000) continue;
    try {
      const market = await getKalshiMarket(trade.ticker);
      const result = market?.result;
      if (result !== "yes" && result !== "no") continue;

      const won = trade.side === result;
      // Blend any partial salvage: exited contracts realized exitPrice each
      // (minus exit fee); the remainder rides to settlement.
      const exited = trade.exitedContracts ?? 0;
      const remaining = Math.max(0, trade.contracts - exited);
      const salvageProceeds = exited > 0 ? exited * (trade.exitPrice ?? 0) - (trade.exitFee ?? 0) : 0;
      const payout = won ? remaining : 0;
      const netPnl = payout + salvageProceeds - trade.cost - trade.fee;
      storage.updateLiveTrade(trade.id, {
        status: won ? "settled_won" : "settled_lost",
        result,
        netPnl,
        settledAt: new Date().toISOString(),
      });
      checkKillSwitch();
    } catch {
      continue;
    }
  }
}

function checkKillSwitch() {
  const maxLoss = parseFloat(storage.getSetting("live_max_total_loss") || "25");
  const total = liveTotalNetPnl();
  if (Number.isFinite(maxLoss) && total <= -Math.abs(maxLoss)) {
    tripKillSwitch(`cumulative live net P&L ${total.toFixed(2)} breached -$${Math.abs(maxLoss).toFixed(2)} limit`);
  }
}

// Salvage exits: mid-window, if the fair-value model (settlement index vs
// strike, time left, realized vol) says our position is dying but the crowd
// still bids meaningfully more than model value, sell them the hope.
// Backtested 2026-09-12 across a full threshold grid: every configuration
// beat hold-to-settlement; 6c edge + 0.35 dying gate recovered ~$12 net per
// ~$20 of drawdown with only ~$4 forfeited on eventual winners. Mechanics:
// selling our side = buying the opposite side at the complement (Kalshi
// auto-nets offsetting positions), so the proven buy path does the exit.
// Runs even while disarmed/curfewed/cooling (closing risk is always allowed);
// needs the stream (model + depth), so it's a stream-transport feature.
async function runSalvageSweep() {
  if (storage.getSetting("live_salvage_enabled") !== "true") return;
  if (liveTransport() !== "stream") return;
  const edge = Math.min(0.30, Math.max(0.02, parseFloat(storage.getSetting("live_salvage_edge") || "0.06")));
  const dyingCap = Math.min(0.9, Math.max(0.05, parseFloat(storage.getSetting("live_salvage_max_model_value") || "0.35")));

  for (const trade of storage.getUnsettledLiveTrades()) {
    if ((trade.exitedContracts ?? 0) > 0) continue; // one salvage per position
    if (trade.contracts <= 0 || trade.spotStrike == null) continue;
    const closeMs = new Date(trade.marketCloseAt).getTime();
    const remainMs = closeMs - Date.now();
    if (!Number.isFinite(remainMs) || remainMs < 50_000 || remainMs > 16 * 60_000) continue;

    const quote = kalshiProdStream.getQuote(trade.ticker, 8_000);
    const spot = kalshiProdStream.getSpot(trade.series);
    const vol = kalshiProdStream.getSpotVolPerSecond(trade.series, 30);
    if (!quote || quote.yesBid == null || quote.yesAsk == null || !spot || vol == null) continue;

    const pUp = valueModelProbUp(spot.value, trade.spotStrike, vol, remainMs / 1000);
    const modelMine = trade.side === "yes" ? pUp : 1 - pUp;
    const exitBid = trade.side === "yes" ? quote.yesBid : 1 - quote.yesAsk;
    const depth = trade.side === "yes" ? quote.yesBidDepth : quote.yesAskDepth;
    if (exitBid <= 0.02 || exitBid >= 0.99) continue;
    if (modelMine > dyingCap || exitBid - modelMine < edge) continue;
    if (depth < trade.contracts) continue;

    try {
      const exchangeIndex = await getMarketExchangeIndexEnv("prod", trade.ticker);
      if (exchangeIndex == null) continue;
      const oppSide = trade.side === "yes" ? "no" : "yes";
      const oppCents = Math.min(99, Math.max(1, Math.round((1 - exitBid) * 100)));
      await ensureShardFundsEnv("prod", exchangeIndex, trade.contracts * (1 - exitBid) + 1);
      const placed = await placeKalshiOrderEnv("prod", {
        ticker: trade.ticker,
        side: oppSide,
        action: "buy",
        count: trade.contracts,
        type: "limit",
        yesPriceCents: oppSide === "yes" ? oppCents : undefined,
        noPriceCents: oppSide === "no" ? oppCents : undefined,
        exchangeIndex,
      });
      if (placed.dryRun || placed.fillCount <= 0) continue;
      const exited = Math.min(trade.contracts, placed.fillCount);
      // average_fill_price is YES-leg. Buying NO at yes-leg a nets us a per
      // contract (pay 1-a, matched pair redeems 1); buying YES at a nets 1-a.
      const realized = placed.averageFillPriceYesLeg != null
        ? (trade.side === "yes" ? placed.averageFillPriceYesLeg : 1 - placed.averageFillPriceYesLeg)
        : exitBid;
      const exitFee = placed.averageFeePaid != null
        ? placed.averageFeePaid * exited
        : kalshiTradingFee(exited, realized);
      if (exited >= trade.contracts) {
        const netPnl = exited * realized - exitFee - trade.cost - trade.fee;
        storage.updateLiveTrade(trade.id, {
          status: "salvaged",
          exitPrice: realized,
          exitedContracts: exited,
          exitFee,
          netPnl,
          settledAt: new Date().toISOString(),
        });
        checkKillSwitch();
        console.log(`${new Date().toISOString()} [live-executor] SALVAGED ${trade.ticker} ${trade.side} x${exited} at ${realized.toFixed(2)} (model ${modelMine.toFixed(2)}) net ${netPnl.toFixed(2)}`);
      } else {
        storage.updateLiveTrade(trade.id, { exitPrice: realized, exitedContracts: exited, exitFee });
        console.log(`${new Date().toISOString()} [live-executor] partial salvage ${trade.ticker} ${exited}/${trade.contracts} at ${realized.toFixed(2)}`);
      }
    } catch (err) {
      console.error(`${new Date().toISOString()} [error] [live-executor] salvage failed for trade ${trade.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

// In stream mode, overlay the websocket book's top onto the market object so
// decideLiveEntry prices off ms-fresh quotes; expose resting depth for the
// pre-fire confirmation. Falls back to the REST market object when the
// stream is stale/down (fresh=false).
function streamOverlay(market: KalshiMarket): { m: KalshiMarket; depthFor: (side: "yes" | "no") => number; fresh: boolean } {
  if (liveTransport() !== "stream") return { m: market, depthFor: () => Infinity, fresh: false };
  const quote = kalshiProdStream.getQuote(market.ticker, 10_000);
  if (!quote || quote.yesAsk == null || quote.yesBid == null) {
    return { m: market, depthFor: () => Infinity, fresh: false };
  }
  return {
    m: { ...market, yes_ask_dollars: quote.yesAsk.toFixed(4), yes_bid_dollars: quote.yesBid.toFixed(4) },
    depthFor: (side) => (side === "yes" ? quote.yesAskDepth : quote.yesBidDepth),
    fresh: true,
  };
}

async function tryLiveEntry(candidate: CandidateStrategy, spec: KalshiStrategySpec, market: KalshiMarket, nowMs: number) {
  const overlay = streamOverlay(market);
  const decision = await decideLiveEntry(spec, overlay.m, nowMs);
  if (!decision.ok) return;
  if (!passesLivePriceGuards(decision.entryPrice)) return;

  // Maker (passive) entry: rest a limit order below the ask to try to capture
  // the spread, rather than crossing it as a taker. Falls back to a taker
  // order on the next tick if it doesn't fill before expiry.
  if ((spec.makerJoinCents ?? 0) > 0) {
    await placeLiveMakerOrder(candidate, spec, market, decision, overlay, nowMs);
    return;
  }
  await placeLiveTakerOrder(candidate, spec, market, decision, overlay, nowMs);
}

// The taker path: the original behavior - an IOC limit at the entry price,
// with one requote-and-retry on a latency miss. Also serves as the maker
// path's fallback when a resting order expires unfilled.
async function placeLiveTakerOrder(
  candidate: CandidateStrategy,
  spec: KalshiStrategySpec,
  market: KalshiMarket,
  initialDecision: { ok: true; side: "yes" | "no"; entryPrice: number },
  initialOverlay: ReturnType<typeof streamOverlay>,
  nowMs: number,
  restingRowId?: number,
) {
  let overlay = initialOverlay;
  let decision: { ok: true; side: "yes" | "no"; entryPrice: number } = initialDecision;

  const orderSize = await computeLiveStake();
  let contracts = Math.max(1, Math.floor(orderSize / decision.entryPrice));

  // Depth confirmation (stream mode, fresh book only): if the level can't
  // absorb our size, don't fire a doomed IOC - the ~2s tick retries while
  // the entry window is still open, no row recorded.
  if (overlay.fresh && overlay.depthFor(decision.side) < contracts) {
    // A maker fallback whose book can't absorb the size records the miss so
    // the resting row doesn't linger as "resting" forever.
    if (restingRowId != null) {
      storage.updateLiveTrade(restingRowId, { status: "unfilled", contracts: 0, cost: 0, fee: 0, makerExpiresAt: null });
    }
    return;
  }
  let entryPrice = decision.entryPrice;
  let cost = contracts * entryPrice;
  let fee = kalshiTradingFee(contracts, entryPrice);

  let status = "failed";
  let orderId: string | null = null;
  let error: string | null = null;
  try {
    const exchangeIndex = await getMarketExchangeIndexEnv("prod", market.ticker);
    if (exchangeIndex == null) throw new Error(`market ${market.ticker} is not listed on the prod exchange`);

    // Up to two attempts: if the first IOC misses (the book moved between
    // quote and order), requote through the SAME entry logic and retry once.
    // The strategy's own price band and the live guards still gate the retry,
    // so this only converts latency misses into fills - it never chases
    // beyond what the spec would have entered at in the first place.
    const MAX_ATTEMPTS = 2;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      contracts = Math.max(1, Math.floor(orderSize / decision.entryPrice));
      entryPrice = decision.entryPrice;
      cost = contracts * entryPrice;
      fee = kalshiTradingFee(contracts, entryPrice);
      const priceCents = Math.min(99, Math.max(1, Math.round(decision.entryPrice * 100)));

      await ensureShardFundsEnv("prod", exchangeIndex, cost + 1);
      const placed = await placeKalshiOrderEnv("prod", {
        ticker: market.ticker,
        side: decision.side,
        action: "buy",
        count: contracts,
        type: "limit",
        yesPriceCents: decision.side === "yes" ? priceCents : undefined,
        noPriceCents: decision.side === "no" ? priceCents : undefined,
        exchangeIndex,
      });
      if (placed.dryRun) {
        throw new Error("unexpected dry-run result from prod order path");
      } else if (placed.fillCount <= 0) {
        status = "unfilled";
        orderId = placed.orderId;
        contracts = 0;
        cost = 0;
        fee = 0;
        if (attempt < MAX_ATTEMPTS) {
          overlay = streamOverlay(market);
          const requote = await decideLiveEntry(spec, overlay.m, Date.now());
          if (requote.ok && requote.side === decision.side && passesLivePriceGuards(requote.entryPrice)
            && (!overlay.fresh || overlay.depthFor(requote.side) >= Math.max(1, Math.floor(orderSize / requote.entryPrice)))) {
            decision = requote;
            continue;
          }
        }
        break;
      } else {
        status = "open";
        orderId = placed.orderId;
        contracts = placed.fillCount;
        if (placed.averageFillPriceYesLeg != null) {
          entryPrice = decision.side === "yes"
            ? placed.averageFillPriceYesLeg
            : 1 - placed.averageFillPriceYesLeg;
        }
        cost = contracts * entryPrice;
        fee = placed.averageFeePaid != null ? placed.averageFeePaid * contracts : kalshiTradingFee(contracts, entryPrice);
        break;
      }
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  // Maker fallback updates its existing "resting" row in place; a plain taker
  // entry creates a fresh row.
  if (restingRowId != null) {
    storage.updateLiveTrade(restingRowId, {
      side: decision.side, entryPrice, contracts, cost, fee, status, orderId, error,
      transport: overlay.fresh ? "stream" : "rest", makerExpiresAt: null,
      placedAt: new Date().toISOString(),
    });
    return;
  }

  storage.createLiveTrade({
    candidateId: candidate.id,
    candidateName: candidate.name,
    ticker: market.ticker,
    series: spec.series,
    side: decision.side,
    entryPrice,
    contracts,
    cost,
    fee,
    status,
    orderId,
    error,
    result: null,
    netPnl: null,
    spotAtEntry: kalshiProdStream.getSpot(spec.series)?.value ?? null,
    spotStrike: market.open_time
      ? kalshiProdStream.getSpotAt(spec.series, new Date(market.open_time).getTime())
      : null,
    transport: overlay.fresh ? "stream" : "rest",
    placedAt: new Date().toISOString(),
    marketCloseAt: market.close_time ?? new Date(nowMs).toISOString(),
    settledAt: null,
  });
}

// ---------------------------------------------------------------------------
// Maker (passive) entry - human-authorized order machinery, 2026-09-15.
// Rests a limit order live_maker_timeout_sec below the ask to capture the
// spread; reconciled on subsequent ticks. Backtest-inert by design (maker
// fills can't be honestly simulated), so this only ever affects live/audition.
// ---------------------------------------------------------------------------

async function placeLiveMakerOrder(
  candidate: CandidateStrategy,
  spec: KalshiStrategySpec,
  market: KalshiMarket,
  decision: { ok: true; side: "yes" | "no"; entryPrice: number },
  overlay: ReturnType<typeof streamOverlay>,
  nowMs: number,
) {
  const orderSize = await computeLiveStake();
  const takerCents = Math.min(99, Math.max(1, Math.round(decision.entryPrice * 100)));
  // Rest makerJoinCents cheaper than taking; never below 1c. If the cushion
  // would erase the whole price there's nothing to rest, so bail to taker.
  const makerCents = takerCents - Math.round(spec.makerJoinCents);
  if (makerCents < 1) {
    await placeLiveTakerOrder(candidate, spec, market, decision, overlay, nowMs);
    return;
  }
  const makerPrice = makerCents / 100;
  const contracts = Math.max(1, Math.floor(orderSize / makerPrice));
  const cost = contracts * makerPrice;

  try {
    const exchangeIndex = await getMarketExchangeIndexEnv("prod", market.ticker);
    if (exchangeIndex == null) throw new Error(`market ${market.ticker} is not listed on the prod exchange`);
    await ensureShardFundsEnv("prod", exchangeIndex, cost + 1);
    const expirationTs = Math.floor(Date.now() / 1000) + makerTimeoutSec();
    const placed = await placeKalshiOrderEnv("prod", {
      ticker: market.ticker,
      side: decision.side,
      action: "buy",
      count: contracts,
      type: "limit",
      yesPriceCents: decision.side === "yes" ? makerCents : undefined,
      noPriceCents: decision.side === "no" ? makerCents : undefined,
      exchangeIndex,
      restingExpirationTs: expirationTs,
    });
    if (placed.dryRun) throw new Error("unexpected dry-run result from prod maker path");

    // The resting order may fill immediately (if the book had crossed) or rest.
    if (placed.fillCount > 0) {
      const fillPrice = placed.averageFillPriceYesLeg != null
        ? (decision.side === "yes" ? placed.averageFillPriceYesLeg : 1 - placed.averageFillPriceYesLeg)
        : makerPrice;
      const filled = placed.fillCount;
      storage.createLiveTrade(makerRow(candidate, spec, market, decision.side, fillPrice, filled,
        filled * fillPrice, placed.averageFeePaid != null ? placed.averageFeePaid * filled : kalshiTradingFee(filled, fillPrice),
        "open", placed.orderId, null, null, nowMs, overlay));
      return;
    }
    // Resting: record the intent; reconcileMakerOrders resolves it.
    storage.createLiveTrade(makerRow(candidate, spec, market, decision.side, makerPrice, contracts, cost, 0,
      "resting", placed.orderId, null, new Date(expirationTs * 1000).toISOString(), nowMs, overlay));
  } catch (err) {
    storage.createLiveTrade(makerRow(candidate, spec, market, decision.side, makerPrice, 0, 0, 0,
      "failed", null, err instanceof Error ? err.message : String(err), null, nowMs, overlay));
  }
}

function makerRow(
  candidate: CandidateStrategy, spec: KalshiStrategySpec, market: KalshiMarket,
  side: "yes" | "no", entryPrice: number, contracts: number, cost: number, fee: number,
  status: string, orderId: string | null, error: string | null, makerExpiresAt: string | null,
  nowMs: number, overlay: ReturnType<typeof streamOverlay>,
) {
  return {
    candidateId: candidate.id,
    candidateName: candidate.name,
    ticker: market.ticker,
    series: spec.series,
    side,
    entryPrice,
    contracts,
    cost,
    fee,
    status,
    orderId,
    error,
    result: null,
    netPnl: null,
    makerExpiresAt,
    spotAtEntry: kalshiProdStream.getSpot(spec.series)?.value ?? null,
    spotStrike: market.open_time
      ? kalshiProdStream.getSpotAt(spec.series, new Date(market.open_time).getTime())
      : null,
    transport: overlay.fresh ? "stream" : "rest",
    placedAt: new Date().toISOString(),
    marketCloseAt: market.close_time ?? new Date(nowMs).toISOString(),
    settledAt: null,
  };
}

// Reconcile resting maker orders each tick: fill -> open; expired unfilled ->
// taker fallback (if the spec still passes) or unfilled. The exchange
// auto-cancels at expiration_ts, so nothing leaks; a belt-and-suspenders
// cancel covers a stuck order.
async function reconcileMakerOrders() {
  const resting = storage.getRestingLiveTrades();
  for (const row of resting) {
   try {
    if (!row.orderId) {
      storage.updateLiveTrade(row.id, { status: "unfilled", makerExpiresAt: null });
      continue;
    }
    const expired = row.makerExpiresAt != null && Date.now() >= Date.parse(row.makerExpiresAt);
    const info = await getKalshiOrderEnv("prod", row.orderId);
    const terminal = info?.status != null
      && ["executed", "canceled", "cancelled", "expired", "closed"].includes(info.status.toLowerCase());
    // Book the fill only once the order can no longer grow (fully done, or its
    // good-till-time lapsed) - otherwise a partial fill mid-rest would be
    // frozen as final and we'd stop watching for the rest.
    if (info && info.fillCount > 0 && (terminal || expired)) {
      const fillPrice = info.averageFillPriceYesLeg != null
        ? (row.side === "yes" ? info.averageFillPriceYesLeg : 1 - info.averageFillPriceYesLeg)
        : row.entryPrice;
      const filled = info.fillCount;
      storage.updateLiveTrade(row.id, {
        status: "open", entryPrice: fillPrice, contracts: filled, cost: filled * fillPrice,
        fee: info.averageFeePaid != null ? info.averageFeePaid * filled : kalshiTradingFee(filled, fillPrice),
        makerExpiresAt: null,
      });
      continue;
    }
    if (!expired) continue; // still resting, still within its window (no fill yet)

    // Expired with no fill. Make sure the order is truly dead, then fall back.
    try { await cancelKalshiOrderEnv("prod", row.orderId); } catch { /* already gone/expired */ }

    // Taker fallback ONLY while the window is still open and the spec still
    // says go - never chase a stale window. Needs the spec, so the candidate
    // must still exist; if it was culled mid-rest, just mark the miss.
    const candidate = row.candidateId != null ? storage.getCandidateById(row.candidateId) : undefined;
    let fellBack = false;
    if (candidate) {
      try {
        const spec = clampSpec(JSON.parse(candidate.spec));
        const { markets } = await getKalshiMarkets({ seriesTicker: row.series, status: "open", limit: 20 });
        const market = markets.find((m) => m.ticker === row.ticker) ?? null;
        if (market) {
          const overlay = streamOverlay(market);
          const decision = await decideLiveEntry(spec, overlay.m, Date.now());
          if (decision.ok && decision.side === row.side && passesLivePriceGuards(decision.entryPrice)) {
            await placeLiveTakerOrder(candidate, spec, market, decision, overlay, Date.now(), row.id);
            fellBack = true;
          }
        }
      } catch { /* fall through to unfilled */ }
    }
    if (!fellBack) {
      storage.updateLiveTrade(row.id, { status: "unfilled", contracts: 0, cost: 0, fee: 0, makerExpiresAt: null });
    }
   } catch (err) {
     console.error(`${new Date().toISOString()} [error] [live-executor] maker reconcile failed for row ${row.id}: ${err instanceof Error ? err.message : String(err)}`);
   }
  }
}

let settleCounter = 0;
async function runLiveTick() {
  // Stream mode ticks every ~2s; settlement checks stay on a ~16s cadence.
  const streaming = liveTransport() === "stream";
  if (!streaming || settleCounter++ % 8 === 0) await settleLiveTrades();
  // Salvage runs before the entry gates: closing risk is always allowed,
  // even while disarmed, curfewed, or cooling down.
  await runSalvageSweep();
  // Reconcile resting maker orders every tick regardless of arm state: a
  // resting order placed while armed must still be resolved (filled, or
  // expired -> fallback/unfilled) even if the desk disarmed meanwhile.
  await reconcileMakerOrders();

  if (!liveEnabled()) return;
  if (!withinLiveTradingHours()) return;
  if (liveCooldown().active) return; // holding fire after a losing streak
  if (trailingStatus().mode === "paused") return; // trailing stop: backed off
  if (!getKalshiAuthStatusEnv("prod").configured) return;

  const armed = getLiveArmedStrategies();
  if (armed.length === 0) return;

  const maxOpen = Math.max(1, parseInt(storage.getSetting("live_max_open_trades") || "2", 10));
  // 0 = no daily cap. The rails that actually bound risk are max open
  // positions, one-position-per-window, and the cumulative-loss kill switch.
  const maxPerDay = Math.max(0, parseInt(storage.getSetting("live_max_trades_per_day") || "20", 10));
  // Pending = filled-open + resting maker orders; both are live exposure.
  if (storage.getPendingLiveTrades().length >= maxOpen) return;
  if (maxPerDay > 0 && liveTradesToday() >= maxPerDay) return;

  const specs = armed.map((candidate) => ({ candidate, spec: clampSpec(JSON.parse(candidate.spec)) }));
  const seriesNeeded = [...new Set(specs.map((s) => s.spec.series))];
  const nowMs = Date.now();

  const actives: { series: string; market: KalshiMarket; closeMs: number }[] = [];
  for (const series of seriesNeeded) {
    const active = await activeMarketFor(series, nowMs);
    if (active) actives.push({ series, ...active });
  }
  if (streaming) {
    // Keep the book stream pointed at our windows (union with the shadow's
    // own subscriptions via the owner key).
    kalshiProdStream.start();
    kalshiProdStream.setMarkets(actives.map((a) => a.market.ticker), "live");
  } else {
    kalshiProdStream.setMarkets([], "live");
  }

  for (const active of actives) {
    const series = active.series;
    const secondsToClose = (active.closeMs - nowMs) / 1000;
    for (const { candidate, spec } of specs) {
      if (spec.series !== series) continue;
      if (secondsToClose > spec.entrySecondsBeforeClose) continue;
      if (secondsToClose < spec.entrySecondsBeforeClose - Math.max(ENTRY_TOLERANCE_SEC, spec.entryWindowSeconds)) continue;
      if (storage.hasLiveTradeFor(candidate.id, active.market.ticker)) continue;
      // Real money: one position per window, full stop - correlated strategies
      // never stack live.
      if (storage.getLiveTrades(50).some((t) => t.ticker === active.market.ticker && t.status !== "failed")) continue;
      if (storage.getPendingLiveTrades().length >= maxOpen) break;
      try {
        await tryLiveEntry(candidate, spec, active.market, nowMs);
      } catch (err) {
        console.error(`${new Date().toISOString()} [error] [live-executor] entry failed for candidate ${candidate.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}

let liveTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleLiveExecutor() {
  const intervalSec = liveTransport() === "stream"
    ? 2
    : Math.max(10, parseInt(storage.getSetting("live_poll_seconds") || "15", 10));
  liveTimer = setTimeout(async () => {
    try {
      await runLiveTick();
    } catch (err) {
      console.error(`${new Date().toISOString()} [error] [live-executor] tick failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    scheduleLiveExecutor();
  }, intervalSec * 1000);
}

export function registerLiveExecutorRoutes(app: Express) {
  ensureLiveDefaults();
  if (!liveTimer) scheduleLiveExecutor();

  app.get("/api/live/status", async (_req, res) => {
    const trades = storage.getLiveTrades(10000);
    const settled = trades.filter((t) => t.netPnl != null);
    const armed = getLiveArmedStrategies();
    let balanceCents: number | null = null;
    if (getKalshiAuthStatusEnv("prod").configured) {
      try {
        const balance = await getKalshiBalanceEnv("prod");
        balanceCents = typeof balance?.balance === "number" ? balance.balance : null;
      } catch { /* surfaced via prodConfigured + self-test instead */ }
    }
    res.json({
      enabled: storage.getSetting("live_executor_enabled") === "true",
      killSwitch: storage.getSetting("live_kill_switch") || "ok",
      killSwitchReason: storage.getSetting("live_kill_switch_reason") || null,
      prodConfigured: getKalshiAuthStatusEnv("prod").configured,
      balanceCents,
      armedStrategies: armed.map((c) => ({ id: c.id, name: c.name, demoTrades: c.demoTrades, demoNetPnl: c.demoNetPnl })),
      openTrades: storage.getPendingLiveTrades().length,
      restingOrders: storage.getRestingLiveTrades().length,
      makerTimeoutSec: makerTimeoutSec(),
      tradesToday: liveTradesToday(),
      orderSize: await computeLiveStake(),
      autoStake: storage.getSetting("live_auto_stake") === "true",
      maxOpenTrades: parseInt(storage.getSetting("live_max_open_trades") || "2", 10),
      maxTradesPerDay: parseInt(storage.getSetting("live_max_trades_per_day") || "20", 10),
      maxTotalLoss: parseFloat(storage.getSetting("live_max_total_loss") || "25"),
      maxEntryPrice: parseFloat(storage.getSetting("live_max_entry_price") || "0.80"),
      tradingHoursEt: storage.getSetting("live_trading_hours_et") || "0-24",
      cooldown: liveCooldown(),
      transport: liveTransport(),
      streamConnected: kalshiProdStream.isConnected(),
      recencyBenched: getRecencyBenched(),
      trailing: trailingStatus(),
      salvage: {
        enabled: storage.getSetting("live_salvage_enabled") === "true",
        edge: parseFloat(storage.getSetting("live_salvage_edge") || "0.06"),
        maxModelValue: parseFloat(storage.getSetting("live_salvage_max_model_value") || "0.35"),
      },
      totalSettled: settled.length,
      totalWins: settled.filter((t) => (t.netPnl ?? 0) > 0).length,
      totalNetPnl: settled.reduce((sum, t) => sum + (t.netPnl ?? 0), 0),
    });
  });

  app.get("/api/live/trades", (req, res) => {
    const limit = Math.min(500, Math.max(1, parseInt((req.query.limit as string) || "100", 10)));
    res.json({ trades: storage.getLiveTrades(limit) });
  });

  app.get("/api/live/pnl-series", (_req, res) => {
    const series = storage.getLiveTrades(20000)
      .filter((t) => t.netPnl != null && t.settledAt != null)
      .sort((a, b) => new Date(a.settledAt!).getTime() - new Date(b.settledAt!).getTime())
      .map((t) => ({ t: t.settledAt, pnl: t.netPnl, name: t.candidateName }));
    res.json({ series });
  });

  app.post("/api/live/self-test", async (_req, res) => {
    try {
      res.json(await runKalshiAuthSelfTestEnv("prod"));
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Going live is deliberately hard to do by accident: the client must send
  // the exact confirmation phrase, prod credentials must already pass config,
  // and the kill switch must not be tripped.
  app.post("/api/live/arm", (req, res) => {
    if (req.body?.confirm !== "GO LIVE") {
      res.status(400).json({ error: 'confirmation phrase mismatch - send { "confirm": "GO LIVE" }' });
      return;
    }
    if (!getKalshiAuthStatusEnv("prod").configured) {
      res.status(400).json({ error: "production API credentials are not configured" });
      return;
    }
    if (storage.getSetting("live_kill_switch") === "tripped") {
      res.status(400).json({ error: "kill switch is tripped - reset it first (separate action)" });
      return;
    }
    if (getLiveArmedStrategies().length === 0) {
      res.status(400).json({ error: "no strategies qualify for the live allowlist yet" });
      return;
    }
    storage.setSetting("live_executor_enabled", "true");
    console.log(`${new Date().toISOString()} [live-executor] ARMED - real-money trading enabled`);
    res.json({ ok: true, enabled: true });
  });

  // Disarming is always one click, no confirmation - stopping must be easy.
  app.post("/api/live/disarm", (_req, res) => {
    storage.setSetting("live_executor_enabled", "false");
    console.log(`${new Date().toISOString()} [live-executor] disarmed - real-money trading disabled`);
    res.json({ ok: true, enabled: false });
  });

  // Deliberate human action: clears the kill switch but does NOT re-enable
  // the executor - that is a second, separate decision.
  app.post("/api/live/reset-kill-switch", (_req, res) => {
    storage.setSetting("live_kill_switch", "ok");
    storage.setSetting("live_kill_switch_reason", "");
    res.json({ ok: true, note: "kill switch cleared; live executor remains disabled until re-enabled" });
  });
}
