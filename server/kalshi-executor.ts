import type { Express } from "express";
import { storage } from "./storage";
import {
  clampSpec,
  getKalshiCandlesticks,
  getKalshiMarket,
  getKalshiMarkets,
  kalshiTradingFee,
  parseDollars,
  type KalshiMarket,
  type KalshiStrategySpec,
} from "./kalshi";
import {
  ensureShardFunds,
  getDemoMarketExchangeIndex,
  getKalshiAuthStatus,
  isKalshiDryRun,
  placeKalshiOrder,
} from "./kalshi-trading";

// The demo executor closes the research loop: promoted Strategy Lab candidates
// watch live markets and place real orders on the Kalshi DEMO account (or
// dry-run records while kalshi_dry_run is on). Settlement results feed back
// into each candidate's demo record, so promoted strategies are judged on
// actual execution, not just walk-forward replays.
//
// v1 simplification: entries are limit orders at the current executable price
// and are assumed filled at that price. Good enough for demo validation;
// fill-tracking against /portfolio/fills is the upgrade before real money
// would ever be discussed.

const ENTRY_TOLERANCE_SEC = 75; // fire within [entry, entry - tolerance] of close

function executorEnabled() {
  return storage.getSetting("kalshi_executor_enabled") === "true";
}

function ensureExecutorDefaults() {
  if (!storage.getSetting("kalshi_executor_enabled")) storage.setSetting("kalshi_executor_enabled", "false");
  if (!storage.getSetting("executor_poll_seconds")) storage.setSetting("executor_poll_seconds", "15");
  if (!storage.getSetting("executor_max_open_trades")) storage.setSetting("executor_max_open_trades", "6");
  if (!storage.getSetting("executor_max_trades_per_day")) storage.setSetting("executor_max_trades_per_day", "120");
  // Correlated strategy variants (e.g. one family of fade specs) tend to fire
  // on the same window and side - this caps how much can stack on one outcome.
  if (!storage.getSetting("executor_max_trades_per_window")) storage.setSetting("executor_max_trades_per_window", "2");
  // Live fill data: deep-underdog quotes on the demo crypto shard almost never
  // fill (0/177 below ~30c vs steady fills at 40-50c). Skip entries below this
  // executable price so the daily budget goes to trades that can happen.
  if (!storage.getSetting("executor_min_fillable_price")) storage.setSetting("executor_min_fillable_price", "0.30");
}

function executorTradesToday() {
  const today = new Date().toISOString().slice(0, 10);
  // Failed attempts (e.g. a Kalshi outage) must not consume the daily budget,
  // or an outage morning blocks real trading for the rest of the day.
  return storage.getExecutorTrades(500)
    .filter((trade) => trade.placedAt.startsWith(today) && trade.status !== "failed").length;
}

type LiveEntryDecision =
  | { ok: true; side: "yes" | "no"; entryPrice: number }
  | { ok: false; reason: string };

// Live twin of the backtester's entry logic in kalshi.ts: same side rules and
// filters, but priced off the market's current executable quotes.
async function decideLiveEntry(
  spec: KalshiStrategySpec,
  market: KalshiMarket,
  nowMs: number,
): Promise<LiveEntryDecision> {
  const yesAsk = parseDollars(market.yes_ask_dollars);
  const yesBid = parseDollars(market.yes_bid_dollars);
  const marketPrice = parseDollars(market.last_price_dollars) ?? yesAsk;
  if (yesAsk == null || yesBid == null || marketPrice == null || yesAsk <= 0 || yesAsk >= 1) {
    return { ok: false, reason: "no usable live quotes" };
  }

  let side: "yes" | "no" | null = null;
  if (spec.sideRule === "always_yes") side = "yes";
  else if (spec.sideRule === "always_no") side = "no";
  else if (spec.sideRule === "momentum" || spec.sideRule === "fade") {
    if (Math.abs(marketPrice - 0.5) < spec.minSignal) return { ok: false, reason: "signal below threshold" };
    const favored = marketPrice >= 0.5 ? "yes" : "no";
    side = spec.sideRule === "momentum" ? favored : favored === "yes" ? "no" : "yes";
  } else {
    // Trend rules need the market's own price history.
    const openMs = market.open_time ? new Date(market.open_time).getTime() : nowMs - 3600_000;
    const candles = await getKalshiCandlesticks(
      spec.series, market.ticker,
      Math.floor(openMs / 1000), Math.floor(nowMs / 1000), 1,
    );
    const sorted = [...candles].sort((a, b) => a.end_period_ts - b.end_period_ts);
    const lookbackTs = Math.floor(nowMs / 1000) - spec.trendLookbackMinutes * 60;
    const pastCandle = [...sorted].reverse().find((c) => c.end_period_ts <= lookbackTs);
    const pastPrice = pastCandle ? parseDollars(pastCandle.price?.close_dollars) : null;
    if (pastPrice == null) return { ok: false, reason: "no candle history for trend lookback" };
    const move = marketPrice - pastPrice;
    if (Math.abs(move) < spec.minSignal) return { ok: false, reason: "trend move below threshold" };
    const trendSide = move >= 0 ? "yes" : "no";
    side = spec.sideRule === "trend_follow" ? trendSide : trendSide === "yes" ? "no" : "yes";
  }
  if (!side) return { ok: false, reason: "no side decision" };

  const entryPrice = side === "yes" ? yesAsk : 1 - yesBid;
  if (entryPrice < spec.minEntryPrice || entryPrice > spec.maxEntryPrice) {
    return { ok: false, reason: "entry price outside band" };
  }
  if (entryPrice <= 0.01 || entryPrice >= 0.99) {
    return { ok: false, reason: "entry price too extreme" };
  }
  return { ok: true, side, entryPrice };
}

async function tryEnterForCandidate(
  candidateId: number,
  candidateName: string,
  spec: KalshiStrategySpec,
  market: KalshiMarket,
  nowMs: number,
) {
  const decision = await decideLiveEntry(spec, market, nowMs);
  if (!decision.ok) return;

  // Fillability floor (live mode only - dry-run keeps scoring the full spec so
  // the walk-forward comparison stays apples to apples).
  const minFillable = parseFloat(storage.getSetting("executor_min_fillable_price") || "0.30");
  if (!isKalshiDryRun() && Number.isFinite(minFillable) && decision.entryPrice < minFillable) return;

  let contracts = Math.max(1, Math.floor(spec.orderSize / decision.entryPrice));
  let entryPrice = decision.entryPrice;
  let cost = contracts * entryPrice;
  let fee = kalshiTradingFee(contracts, entryPrice);
  const priceCents = Math.min(99, Math.max(1, Math.round(decision.entryPrice * 100)));

  let status = "failed";
  let orderId: string | null = null;
  let error: string | null = null;
  try {
    let exchangeIndex: number | undefined;
    if (!isKalshiDryRun()) {
      // Sharded demo exchange: resolve the market's shard and make sure
      // collateral is preallocated there before the order goes out.
      const resolved = await getDemoMarketExchangeIndex(market.ticker);
      if (resolved == null) throw new Error(`market ${market.ticker} is not listed on the demo exchange`);
      exchangeIndex = resolved;
      await ensureShardFunds(exchangeIndex, cost + 1);
    }
    const placed = await placeKalshiOrder({
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
      status = "dry_run";
    } else if (placed.fillCount <= 0) {
      // IOC came back empty - the quoted liquidity wasn't really there.
      // Recorded so the fill-rate itself becomes measurable data.
      status = "unfilled";
      orderId = placed.orderId;
      contracts = 0;
      cost = 0;
      fee = 0;
    } else {
      // Real fill: record actuals from the exchange, not our assumptions.
      // average_fill_price is YES-leg; convert back for NO entries.
      status = "open";
      orderId = placed.orderId;
      contracts = placed.fillCount;
      if (placed.averageFillPriceYesLeg != null) {
        entryPrice = decision.side === "yes"
          ? placed.averageFillPriceYesLeg
          : 1 - placed.averageFillPriceYesLeg;
      }
      cost = contracts * entryPrice;
      fee = placed.averageFeePaid != null
        ? placed.averageFeePaid * contracts
        : kalshiTradingFee(contracts, entryPrice);
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  storage.createExecutorTrade({
    candidateId,
    candidateName,
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
    placedAt: new Date().toISOString(),
    marketCloseAt: market.close_time ?? new Date(nowMs).toISOString(),
    settledAt: null,
  });
}

async function settleExecutorTrades() {
  const unsettled = storage.getUnsettledExecutorTrades();
  for (const trade of unsettled) {
    const closeMs = new Date(trade.marketCloseAt).getTime();
    if (!Number.isFinite(closeMs) || Date.now() - closeMs < 2 * 60 * 1000) continue;
    try {
      const market = await getKalshiMarket(trade.ticker);
      const result = market?.result;
      if (result !== "yes" && result !== "no") continue;

      const won = trade.side === result;
      const payout = won ? trade.contracts : 0;
      const netPnl = payout - trade.cost - trade.fee;
      storage.updateExecutorTrade(trade.id, {
        status: won ? "settled_won" : "settled_lost",
        result,
        netPnl,
        settledAt: new Date().toISOString(),
      });

      if (trade.candidateId != null) {
        const candidate = storage.getCandidateStrategies().find((c) => c.id === trade.candidateId);
        if (candidate) {
          storage.updateCandidateStrategy(candidate.id, {
            demoTrades: (candidate.demoTrades ?? 0) + 1,
            demoWins: (candidate.demoWins ?? 0) + (won ? 1 : 0),
            demoNetPnl: (candidate.demoNetPnl ?? 0) + netPnl,
          });
        }
      }
    } catch {
      continue;
    }
  }
}

async function runExecutorTick() {
  await settleExecutorTrades();

  if (!executorEnabled()) return;
  if (!getKalshiAuthStatus().configured) return;

  const promoted = storage.getCandidateStrategies("promoted");
  if (promoted.length === 0) return;

  const maxOpen = Math.max(1, parseInt(storage.getSetting("executor_max_open_trades") || "6", 10));
  const maxPerDay = Math.max(1, parseInt(storage.getSetting("executor_max_trades_per_day") || "120", 10));
  if (storage.getUnsettledExecutorTrades().length >= maxOpen) return;
  if (executorTradesToday() >= maxPerDay) return;

  const specs = promoted.map((candidate) => ({
    candidate,
    spec: clampSpec(JSON.parse(candidate.spec)),
  }));
  const seriesNeeded = [...new Set(specs.map((s) => s.spec.series))];
  const nowMs = Date.now();

  for (const series of seriesNeeded) {
    let markets: KalshiMarket[] = [];
    try {
      markets = (await getKalshiMarkets({ seriesTicker: series, status: "open", limit: 10 })).markets;
    } catch {
      continue;
    }
    // The active window: nearest future close.
    const active = markets
      .map((market) => ({ market, closeMs: market.close_time ? new Date(market.close_time).getTime() : NaN }))
      .filter((entry) => Number.isFinite(entry.closeMs) && entry.closeMs > nowMs)
      .sort((a, b) => a.closeMs - b.closeMs)[0];
    if (!active) continue;

    const secondsToClose = (active.closeMs - nowMs) / 1000;
    const maxPerWindow = Math.max(1, parseInt(storage.getSetting("executor_max_trades_per_window") || "2", 10));
    for (const { candidate, spec } of specs) {
      if (spec.series !== series) continue;
      // Fire once, inside the tolerance window around the spec's entry moment.
      if (secondsToClose > spec.entrySecondsBeforeClose) continue;
      if (secondsToClose < spec.entrySecondsBeforeClose - ENTRY_TOLERANCE_SEC) continue;
      if (storage.hasExecutorTradeFor(candidate.id, active.market.ticker)) continue;
      if (storage.countExecutorTradesForTicker(active.market.ticker) >= maxPerWindow) break;
      if (storage.getUnsettledExecutorTrades().length >= maxOpen) break;
      try {
        await tryEnterForCandidate(candidate.id, candidate.name, spec, active.market, nowMs);
      } catch (err) {
        console.error(`${new Date().toISOString()} [error] [executor] entry failed for candidate ${candidate.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}

let executorTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleExecutor() {
  const intervalSec = Math.max(10, parseInt(storage.getSetting("executor_poll_seconds") || "15", 10));
  executorTimer = setTimeout(async () => {
    try {
      await runExecutorTick();
    } catch (err) {
      console.error(`${new Date().toISOString()} [error] [executor] tick failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    scheduleExecutor();
  }, intervalSec * 1000);
}

export function registerExecutorRoutes(app: Express) {
  ensureExecutorDefaults();
  if (!executorTimer) scheduleExecutor();

  app.get("/api/executor/status", (_req, res) => {
    const settled = storage.getExecutorSettledAggregate();
    res.json({
      enabled: executorEnabled(),
      dryRun: isKalshiDryRun(),
      kalshiConfigured: getKalshiAuthStatus().configured,
      promotedStrategies: storage.getCandidateStrategies("promoted").length,
      openTrades: storage.getUnsettledExecutorTrades().length,
      tradesToday: executorTradesToday(),
      maxOpenTrades: parseInt(storage.getSetting("executor_max_open_trades") || "6", 10),
      maxTradesPerDay: parseInt(storage.getSetting("executor_max_trades_per_day") || "120", 10),
      maxTradesPerWindow: parseInt(storage.getSetting("executor_max_trades_per_window") || "2", 10),
      totalSettled: settled.count,
      totalNetPnl: settled.netPnl,
    });
  });

  app.get("/api/executor/trades", (req, res) => {
    const limit = Math.min(200, Math.max(1, parseInt((req.query.limit as string) || "50", 10)));
    res.json({ trades: storage.getExecutorTrades(limit) });
  });
}
