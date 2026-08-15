import type { Express } from "express";
import crypto from "crypto";
import { storage } from "./storage";
import type { CandidateStrategy, PerpTrade } from "@shared/schema";
import {
  clampPerpSpec,
  getPerpCandles,
  getPerpTakerFeeRate,
  getPerpTopOfBook,
  parsePerpDollars,
  type PerpStrategySpec,
} from "./kalshi-perps";
import { getKalshiAuthStatus, isKalshiDryRun, kalshiPrivateFetch } from "./kalshi-trading";

// The perps desk executor: promoted kind=perp candidates take real long/short
// positions on Kalshi's demo perpetual futures - the one crypto venue where
// demo has genuine liquidity, so fills, slippage, and fees here are real.
//
// Risk rails, in order of importance:
//  - tiny fixed notional per position ($50 default)
//  - hard cap on concurrent positions and daily entries
//  - every exit is reduce_only IOC: it can flatten, never flip or grow
//  - TP/SL/time-stop management every tick; no position outlives its spec
//  - margin cash is topped up from the event-contract wallet in small chunks

function perpExecutorEnabled() {
  return storage.getSetting("perp_executor_enabled") === "true";
}

function ensurePerpExecutorDefaults() {
  if (!storage.getSetting("perp_executor_enabled")) storage.setSetting("perp_executor_enabled", "false");
  if (!storage.getSetting("perp_max_open_trades")) storage.setSetting("perp_max_open_trades", "2");
  if (!storage.getSetting("perp_max_trades_per_day")) storage.setSetting("perp_max_trades_per_day", "40");
  if (!storage.getSetting("perp_poll_seconds")) storage.setSetting("perp_poll_seconds", "25");
}

function perpTradesToday() {
  const today = new Date().toISOString().slice(0, 10);
  return storage.getPerpTrades(300)
    .filter((t) => t.openedAt.startsWith(today) && t.status !== "failed" && t.status !== "unfilled").length;
}

// ---------------------------------------------------------------------------
// Margin account plumbing
// ---------------------------------------------------------------------------

async function getMarginCashDollars(): Promise<number | null> {
  try {
    const response = await kalshiPrivateFetch("GET", "/margin/balance");
    for (const key of ["cash_balance", "cash_balance_dollars", "balance", "total_balance", "total_balance_dollars"]) {
      const parsed = parsePerpDollars(response?.[key]);
      if (parsed != null) return parsed;
    }
    console.error(`${new Date().toISOString()} [error] [perp-executor] unrecognized margin balance shape: ${JSON.stringify(response).slice(0, 200)}`);
    return null;
  } catch (err) {
    console.error(`${new Date().toISOString()} [error] [perp-executor] margin balance fetch failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

let lastMarginTransferMs = 0;
async function ensureMarginFunds(minDollars: number): Promise<void> {
  const cash = await getMarginCashDollars();
  if (cash != null && cash >= minDollars) return;
  // Rate-limit funding attempts so a parse problem can't loop transfers.
  if (Date.now() - lastMarginTransferMs < 10 * 60 * 1000) {
    if (cash == null) return; // balance unknown but recently funded - proceed on faith
    throw new Error(`margin cash $${cash.toFixed(2)} below $${minDollars.toFixed(2)}; recent transfer still settling`);
  }
  lastMarginTransferMs = Date.now();
  const amount = Math.max(100, minDollars * 2);
  await kalshiPrivateFetch("POST", "/portfolio/intra_exchange_instance_transfer", {
    source: "event_contract",
    destination: "margined",
    amount: Math.round(amount * 10000), // centicents
    source_exchange_shard: 0,
    destination_exchange_shard: 0,
  });
  console.log(`${new Date().toISOString()} [info] [perp-executor] transferring $${amount.toFixed(2)} event_contract -> margined`);
  for (let attempt = 0; attempt < 4; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const refreshed = await getMarginCashDollars();
    if (refreshed != null && refreshed >= minDollars) return;
  }
  throw new Error("margin funding still settling - will retry next tick");
}

type PerpOrderResult = { orderId: string | null; fillCount: number; avgPrice: number | null; avgFeePerContract: number | null };

async function placePerpOrder(
  market: string,
  bookSide: "bid" | "ask",
  contracts: number,
  priceDollars: number,
  reduceOnly: boolean,
): Promise<PerpOrderResult> {
  const response = await kalshiPrivateFetch("POST", "/margin/orders", {
    ticker: market,
    client_order_id: crypto.randomUUID(),
    side: bookSide,
    count: contracts.toFixed(2),
    price: priceDollars.toFixed(4),
    time_in_force: "immediate_or_cancel",
    self_trade_prevention_type: "taker_at_cross",
    reduce_only: reduceOnly,
  });
  const parseFp = (value: unknown) => {
    const parsed = parseFloat(String(value ?? ""));
    return Number.isFinite(parsed) ? parsed : null;
  };
  return {
    orderId: typeof response?.order_id === "string" ? response.order_id : null,
    fillCount: parseFp(response?.fill_count) ?? 0,
    avgPrice: parseFp(response?.average_fill_price),
    avgFeePerContract: parseFp(response?.average_fee_paid),
  };
}

// ---------------------------------------------------------------------------
// Position management
// ---------------------------------------------------------------------------

function getSpecForTrade(trade: PerpTrade, candidates: CandidateStrategy[]): PerpStrategySpec {
  const candidate = candidates.find((c) => c.id === trade.candidateId);
  if (candidate) return clampPerpSpec(JSON.parse(candidate.spec));
  // Candidate deleted: conservative defaults so the position still gets closed.
  return clampPerpSpec({ market: trade.market, maxHoldMinutes: 60, takeProfitPct: 0.4, stopLossPct: 0.3 });
}

async function manageOpenPerpTrades(bookCache: Map<string, { bid: number | null; ask: number | null }>) {
  const open = storage.getOpenPerpTrades();
  if (open.length === 0) return;
  const candidates = storage.getCandidateStrategies();
  const feeRate = getPerpTakerFeeRate();

  for (const trade of open) {
    if (trade.entryPrice == null || trade.contracts == null) continue;
    const spec = getSpecForTrade(trade, candidates);
    if (!bookCache.has(trade.market)) {
      try {
        bookCache.set(trade.market, await getPerpTopOfBook(trade.market));
      } catch {
        continue;
      }
    }
    const book = bookCache.get(trade.market)!;
    const exitQuote = trade.side === "long" ? book.bid : book.ask;
    if (exitQuote == null) continue;

    const heldMinutes = (Date.now() - new Date(trade.openedAt).getTime()) / 60000;
    const movePct = trade.side === "long"
      ? ((exitQuote - trade.entryPrice) / trade.entryPrice) * 100
      : ((trade.entryPrice - exitQuote) / trade.entryPrice) * 100;

    let exitReason: string | null = null;
    if (movePct <= -spec.stopLossPct) exitReason = "stop_loss";
    else if (movePct >= spec.takeProfitPct) exitReason = "take_profit";
    else if (heldMinutes >= spec.maxHoldMinutes) exitReason = "time_stop";
    if (!exitReason) continue;

    try {
      if (trade.status === "dry_run") {
        // Paper exit at the current book quote.
        const gross = trade.side === "long"
          ? trade.contracts * (exitQuote - trade.entryPrice)
          : trade.contracts * (trade.entryPrice - exitQuote);
        const exitFee = trade.contracts * exitQuote * feeRate;
        storage.updatePerpTrade(trade.id, {
          status: "closed",
          exitPrice: exitQuote,
          exitFee,
          exitReason,
          netPnl: gross - (trade.entryFee ?? 0) - exitFee,
          closedAt: new Date().toISOString(),
        });
        creditCandidate(trade, gross - (trade.entryFee ?? 0) - exitFee);
        continue;
      }

      // Real exit: reduce_only IOC crossing the book.
      const bookSide = trade.side === "long" ? "ask" : "bid";
      const result = await placePerpOrder(trade.market, bookSide, trade.contracts, exitQuote, true);
      if (result.fillCount <= 0) continue; // book moved; retry next tick

      const avgExit = result.avgPrice ?? exitQuote;
      const filled = Math.min(result.fillCount, trade.contracts);
      const gross = trade.side === "long"
        ? filled * (avgExit - trade.entryPrice)
        : filled * (trade.entryPrice - avgExit);
      const exitFee = result.avgFeePerContract != null
        ? result.avgFeePerContract * filled
        : filled * avgExit * feeRate;
      const realized = gross - exitFee;
      const remaining = trade.contracts - filled;

      if (remaining <= 0.01) {
        storage.updatePerpTrade(trade.id, {
          status: "closed",
          exitPrice: avgExit,
          exitFee: (trade.exitFee ?? 0) + exitFee,
          exitOrderId: result.orderId,
          exitReason,
          netPnl: (trade.netPnl ?? 0) + realized - (trade.entryFee ?? 0),
          closedAt: new Date().toISOString(),
        });
        creditCandidate(trade, (trade.netPnl ?? 0) + realized - (trade.entryFee ?? 0));
      } else {
        // Partial exit: bank the realized part, keep the rest open.
        storage.updatePerpTrade(trade.id, {
          contracts: remaining,
          exitFee: (trade.exitFee ?? 0) + exitFee,
          netPnl: (trade.netPnl ?? 0) + realized,
        });
      }
    } catch (err) {
      console.error(`${new Date().toISOString()} [error] [perp-executor] exit failed for trade ${trade.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

function creditCandidate(trade: PerpTrade, netPnl: number) {
  if (trade.candidateId == null) return;
  const candidate = storage.getCandidateStrategies().find((c) => c.id === trade.candidateId);
  if (!candidate) return;
  storage.updateCandidateStrategy(candidate.id, {
    demoTrades: (candidate.demoTrades ?? 0) + 1,
    demoWins: (candidate.demoWins ?? 0) + (netPnl > 0 ? 1 : 0),
    demoNetPnl: (candidate.demoNetPnl ?? 0) + netPnl,
  });
}

// ---------------------------------------------------------------------------
// Entries
// ---------------------------------------------------------------------------

async function tryPerpEntry(
  candidate: CandidateStrategy,
  spec: PerpStrategySpec,
  bookCache: Map<string, { bid: number | null; ask: number | null }>,
  candleCache: Map<string, { ts: number; close: number }[]>,
) {
  if (!candleCache.has(spec.market)) {
    const endTs = Math.floor(Date.now() / 1000);
    const candles = await getPerpCandles(spec.market, endTs - (spec.lookbackMinutes + 10) * 60, endTs, 1);
    candleCache.set(spec.market, candles
      .map((c) => ({ ts: c.end_period_ts, close: parsePerpDollars(c.price?.close) ?? 0 }))
      .filter((c) => c.close > 0)
      .sort((a, b) => a.ts - b.ts));
  }
  const closes = candleCache.get(spec.market)!;
  if (closes.length < spec.lookbackMinutes) return;
  const now = closes[closes.length - 1];
  const pastTarget = now.ts - spec.lookbackMinutes * 60;
  const past = [...closes].reverse().find((c) => c.ts <= pastTarget);
  if (!past) return;
  const movePct = ((now.close - past.close) / past.close) * 100;
  if (Math.abs(movePct) < spec.entryThresholdPct) return;

  const trendSide: "long" | "short" = movePct >= 0 ? "long" : "short";
  const side = spec.direction === "trend_follow" ? trendSide : trendSide === "long" ? "short" : "long";

  if (!bookCache.has(spec.market)) {
    bookCache.set(spec.market, await getPerpTopOfBook(spec.market));
  }
  const book = bookCache.get(spec.market)!;
  const entryQuote = side === "long" ? book.ask : book.bid;
  if (entryQuote == null || entryQuote <= 0) return;

  const contracts = Math.round((spec.notional / entryQuote) * 100) / 100;
  if (contracts < 0.01) return;
  const feeRate = getPerpTakerFeeRate();

  if (isKalshiDryRun()) {
    storage.createPerpTrade({
      candidateId: candidate.id,
      candidateName: candidate.name,
      market: spec.market,
      side,
      entryPrice: entryQuote,
      exitPrice: null,
      contracts,
      notional: spec.notional,
      entryFee: spec.notional * feeRate,
      exitFee: null,
      status: "dry_run",
      exitReason: null,
      entryOrderId: null,
      exitOrderId: null,
      error: null,
      netPnl: null,
      openedAt: new Date().toISOString(),
      closedAt: null,
    });
    return;
  }

  let status = "failed";
  let error: string | null = null;
  let orderId: string | null = null;
  let entryPrice = entryQuote;
  let filledContracts = contracts;
  let entryFee = spec.notional * feeRate;
  try {
    await ensureMarginFunds(spec.notional + 10);
    const bookSide = side === "long" ? "bid" : "ask";
    const result = await placePerpOrder(spec.market, bookSide, contracts, entryQuote, false);
    orderId = result.orderId;
    if (result.fillCount <= 0) {
      status = "unfilled";
      filledContracts = 0;
      entryFee = 0;
    } else {
      status = "open";
      filledContracts = result.fillCount;
      entryPrice = result.avgPrice ?? entryQuote;
      entryFee = result.avgFeePerContract != null
        ? result.avgFeePerContract * filledContracts
        : filledContracts * entryPrice * feeRate;
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  storage.createPerpTrade({
    candidateId: candidate.id,
    candidateName: candidate.name,
    market: spec.market,
    side,
    entryPrice,
    exitPrice: null,
    contracts: filledContracts,
    notional: spec.notional,
    entryFee,
    exitFee: null,
    status,
    exitReason: null,
    entryOrderId: orderId,
    exitOrderId: null,
    error,
    netPnl: null,
    openedAt: new Date().toISOString(),
    closedAt: null,
  });
}

async function runPerpExecutorTick() {
  const bookCache = new Map<string, { bid: number | null; ask: number | null }>();
  await manageOpenPerpTrades(bookCache);

  if (!perpExecutorEnabled()) return;
  if (!getKalshiAuthStatus().configured) return;

  const promoted = storage.getCandidateStrategies("promoted").filter((c) => c.kind === "perp");
  if (promoted.length === 0) return;

  const maxOpen = Math.max(1, parseInt(storage.getSetting("perp_max_open_trades") || "2", 10));
  const maxPerDay = Math.max(1, parseInt(storage.getSetting("perp_max_trades_per_day") || "40", 10));
  if (perpTradesToday() >= maxPerDay) return;

  const openTrades = storage.getOpenPerpTrades();
  const candleCache = new Map<string, { ts: number; close: number }[]>();
  for (const candidate of promoted) {
    if (storage.getOpenPerpTrades().length >= maxOpen) break;
    if (openTrades.some((t) => t.candidateId === candidate.id)) continue;
    try {
      await tryPerpEntry(candidate, clampPerpSpec(JSON.parse(candidate.spec)), bookCache, candleCache);
    } catch (err) {
      console.error(`${new Date().toISOString()} [error] [perp-executor] entry failed for candidate ${candidate.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

let perpTimer: ReturnType<typeof setTimeout> | null = null;
function schedulePerpExecutor() {
  const intervalSec = Math.max(15, parseInt(storage.getSetting("perp_poll_seconds") || "25", 10));
  perpTimer = setTimeout(async () => {
    try {
      await runPerpExecutorTick();
    } catch (err) {
      console.error(`${new Date().toISOString()} [error] [perp-executor] tick failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    schedulePerpExecutor();
  }, intervalSec * 1000);
}

export function registerPerpExecutorRoutes(app: Express) {
  ensurePerpExecutorDefaults();
  if (!perpTimer) schedulePerpExecutor();

  app.get("/api/perps/executor/status", (_req, res) => {
    const trades = storage.getPerpTrades(300);
    const closed = trades.filter((t) => t.status === "closed" && t.netPnl != null);
    res.json({
      enabled: perpExecutorEnabled(),
      dryRun: isKalshiDryRun(),
      kalshiConfigured: getKalshiAuthStatus().configured,
      promotedPerpStrategies: storage.getCandidateStrategies("promoted").filter((c) => c.kind === "perp").length,
      openPositions: storage.getOpenPerpTrades().length,
      tradesToday: perpTradesToday(),
      maxOpenTrades: parseInt(storage.getSetting("perp_max_open_trades") || "2", 10),
      maxTradesPerDay: parseInt(storage.getSetting("perp_max_trades_per_day") || "40", 10),
      totalClosed: closed.length,
      totalNetPnl: closed.reduce((sum, t) => sum + (t.netPnl ?? 0), 0),
    });
  });

  app.get("/api/perps/trades", (req, res) => {
    const limit = Math.min(200, Math.max(1, parseInt((req.query.limit as string) || "50", 10)));
    res.json({ trades: storage.getPerpTrades(limit) });
  });
}
