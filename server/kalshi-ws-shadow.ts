import type { Express } from "express";
import { storage } from "./storage";
import {
  clampSpec,
  getKalshiMarket,
  getKalshiMarkets,
  kalshiTradingFee,
  type KalshiMarket,
  type KalshiStrategySpec,
} from "./kalshi";
import { decideLiveEntry } from "./kalshi-executor";
import { getLiveArmedStrategies, passesLivePriceGuards } from "./kalshi-live-executor";
import { kalshiProdStream } from "./kalshi-ws";
import type { CandidateStrategy } from "@shared/schema";

// The WebSocket SHADOW executor: an A/B experiment against the REST live
// executor, run on the same production account's market data.
//
//   Same allowlist. Same entry logic (decideLiveEntry). Same guards, sizing,
//   and one-position-per-window rule. The ONLY differences: quotes come from
//   the streamed orderbook instead of 15s REST polls, evaluation runs every
//   second, and NOTHING is ever sent to the exchange. Entries are recorded to
//   ws_shadow_trades with the streamed price, the depth resting at that
//   price (the fill proxy), and quote age; they settle against real market
//   results so a would-be P&L accumulates.
//
// Comparing ws_shadow_trades to live_trades window-by-window answers: how
// many fills and how much P&L is the 15s polling transport costing us?

const ENTRY_TOLERANCE_SEC = 75;
const MARKET_REFRESH_MS = 20_000;

function shadowEnabled() {
  return storage.getSetting("ws_shadow_enabled") === "true";
}

function ensureShadowDefaults() {
  // Rehearsal only - no money at risk - so it defaults ON and starts
  // collecting comparison data as soon as prod credentials exist.
  if (!storage.getSetting("ws_shadow_enabled")) storage.setSetting("ws_shadow_enabled", "true");
}

// Active-market cache per series, refreshed by REST (close times and tickers
// change slowly; only the QUOTES need to be fast).
type SeriesState = { market: KalshiMarket; closeMs: number } | null;
const seriesCache = new Map<string, { state: SeriesState; fetchedAt: number }>();

async function activeMarketForSeries(series: string, nowMs: number): Promise<SeriesState> {
  const cached = seriesCache.get(series);
  if (cached && nowMs - cached.fetchedAt < MARKET_REFRESH_MS) return cached.state;
  let state: SeriesState = null;
  try {
    const { markets } = await getKalshiMarkets({ seriesTicker: series, status: "open", limit: 10 });
    const next = markets
      .map((market) => ({ market, closeMs: market.close_time ? new Date(market.close_time).getTime() : NaN }))
      .filter((entry) => Number.isFinite(entry.closeMs) && entry.closeMs > nowMs)
      .sort((a, b) => a.closeMs - b.closeMs)[0];
    state = next ?? null;
  } catch {
    state = cached?.state ?? null;
  }
  seriesCache.set(series, { state, fetchedAt: nowMs });
  return state;
}

async function settleShadowTrades() {
  for (const trade of storage.getUnsettledWsShadowTrades()) {
    const closeMs = new Date(trade.marketCloseAt).getTime();
    if (!Number.isFinite(closeMs) || Date.now() - closeMs < 2 * 60 * 1000) continue;
    try {
      const market = await getKalshiMarket(trade.ticker);
      const result = market?.result;
      if (result !== "yes" && result !== "no") continue;

      if (trade.status === "would_fill") {
        const won = trade.side === result;
        const payout = won ? trade.contracts : 0;
        storage.updateWsShadowTrade(trade.id, {
          status: won ? "settled_won" : "settled_lost",
          result,
          netPnl: payout - trade.cost - trade.fee,
          settledAt: new Date().toISOString(),
        });
      } else {
        // no_depth: terminal miss - record how the market resolved anyway so
        // the missed-trade EV is measurable, but no simulated P&L.
        storage.updateWsShadowTrade(trade.id, { result, settledAt: new Date().toISOString() });
      }
    } catch {
      continue;
    }
  }
}

async function tryShadowEntry(candidate: CandidateStrategy, spec: KalshiStrategySpec, market: KalshiMarket, nowMs: number) {
  const quote = kalshiProdStream.getQuote(market.ticker);
  if (!quote || quote.yesAsk == null || quote.yesBid == null) return;

  // Same decision function the live executor runs, but priced off the
  // streamed book: overlay the stream's top-of-book onto the market object.
  const streamed: KalshiMarket = {
    ...market,
    yes_ask_dollars: quote.yesAsk.toFixed(4),
    yes_bid_dollars: quote.yesBid.toFixed(4),
  };
  const decision = await decideLiveEntry(spec, streamed, nowMs);
  if (!decision.ok) return;
  if (!passesLivePriceGuards(decision.entryPrice)) return;

  const orderSize = Math.max(0.5, parseFloat(storage.getSetting("live_order_size") || "2"));
  const contracts = Math.max(1, Math.floor(orderSize / decision.entryPrice));
  const cost = contracts * decision.entryPrice;
  const fee = kalshiTradingFee(contracts, decision.entryPrice);
  // Fill proxy: enough contracts resting at the level we'd hit. Buying YES
  // lifts the ask (NO-bid depth); buying NO hits the YES-bid depth.
  const depth = decision.side === "yes" ? quote.yesAskDepth : quote.yesBidDepth;
  const wouldFill = depth >= contracts;

  storage.createWsShadowTrade({
    candidateId: candidate.id,
    candidateName: candidate.name,
    ticker: market.ticker,
    series: spec.series,
    side: decision.side,
    entryPrice: decision.entryPrice,
    contracts,
    cost,
    fee,
    depthAtEntry: depth,
    wouldFill,
    quoteAgeMs: quote.ageMs,
    status: wouldFill ? "would_fill" : "no_depth",
    result: null,
    netPnl: null,
    placedAt: new Date().toISOString(),
    marketCloseAt: market.close_time ?? new Date(nowMs).toISOString(),
    settledAt: null,
  });
}

let settleCounter = 0;

async function runShadowTick() {
  // Settlement is cheap to check but doesn't need 1s cadence.
  if (settleCounter++ % 30 === 0) await settleShadowTrades();

  if (!shadowEnabled()) {
    kalshiProdStream.setMarkets([]);
    return;
  }

  const armed = getLiveArmedStrategies();
  if (armed.length === 0) {
    kalshiProdStream.setMarkets([]);
    return;
  }
  kalshiProdStream.start();

  const specs = armed.map((candidate) => ({ candidate, spec: clampSpec(JSON.parse(candidate.spec)) }));
  const seriesNeeded = [...new Set(specs.map((s) => s.spec.series))];
  const nowMs = Date.now();

  // Keep the stream pointed at the active window of every needed series.
  const actives: { series: string; market: KalshiMarket; closeMs: number }[] = [];
  for (const series of seriesNeeded) {
    const state = await activeMarketForSeries(series, nowMs);
    if (state) actives.push({ series, ...state });
  }
  kalshiProdStream.setMarkets(actives.map((a) => a.market.ticker));

  const maxOpen = Math.max(1, parseInt(storage.getSetting("live_max_open_trades") || "2", 10));

  for (const active of actives) {
    const secondsToClose = (active.closeMs - nowMs) / 1000;
    for (const { candidate, spec } of specs) {
      if (spec.series !== active.series) continue;
      if (secondsToClose > spec.entrySecondsBeforeClose) continue;
      if (secondsToClose < spec.entrySecondsBeforeClose - ENTRY_TOLERANCE_SEC) continue;
      if (storage.hasWsShadowTradeFor(candidate.id, active.market.ticker)) continue;
      // Mirror the live executor's rails exactly so the comparison is fair.
      if (storage.getWsShadowTrades(50).some((t) => t.ticker === active.market.ticker)) continue;
      if (storage.getUnsettledWsShadowTrades().filter((t) => t.status === "would_fill").length >= maxOpen) break;
      try {
        await tryShadowEntry(candidate, spec, active.market, nowMs);
      } catch (err) {
        console.error(`${new Date().toISOString()} [error] [ws-shadow] entry failed for candidate ${candidate.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}

let shadowTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleShadow() {
  shadowTimer = setTimeout(async () => {
    try {
      await runShadowTick();
    } catch (err) {
      console.error(`${new Date().toISOString()} [error] [ws-shadow] tick failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    scheduleShadow();
  }, 1000);
}

// Window-by-window comparison against the REST live executor. A "window" is
// one market ticker; both executors saw the same books and windows, so any
// divergence is transport.
function buildComparison() {
  const shadow = storage.getWsShadowTrades(500);
  // Fair summary: only count REST trades from the period the shadow was also
  // watching (rows come newest-first, so the oldest shadow row is last).
  const shadowStart = shadow.length > 0 ? shadow[shadow.length - 1].placedAt : null;
  const live = storage.getLiveTrades(500)
    .filter((t) => shadowStart == null || t.placedAt >= shadowStart);
  const liveByTicker = new Map(live.map((t) => [t.ticker, t] as const));
  const rows = shadow
    .slice(0, 60)
    .map((s) => {
      const l = liveByTicker.get(s.ticker);
      return {
        ticker: s.ticker,
        side: s.side,
        placedAt: s.placedAt,
        ws: {
          entryPrice: s.entryPrice,
          wouldFill: s.wouldFill,
          depth: s.depthAtEntry,
          status: s.status,
          netPnl: s.netPnl,
        },
        rest: l
          ? { entryPrice: l.entryPrice, status: l.status, filled: l.status !== "unfilled" && l.status !== "failed", netPnl: l.netPnl }
          : null,
      };
    });

  const shadowSettled = shadow.filter((t) => t.netPnl != null);
  const shadowAttempts = shadow.length;
  const shadowFills = shadow.filter((t) => t.wouldFill).length;
  const liveAttempts = live.filter((t) => t.status !== "failed").length;
  const liveFills = live.filter((t) => t.status !== "failed" && t.status !== "unfilled").length;
  return {
    summary: {
      ws: {
        attempts: shadowAttempts,
        wouldFill: shadowFills,
        fillRate: shadowAttempts > 0 ? shadowFills / shadowAttempts : null,
        settled: shadowSettled.length,
        wins: shadowSettled.filter((t) => (t.netPnl ?? 0) > 0).length,
        netPnl: shadowSettled.reduce((sum, t) => sum + (t.netPnl ?? 0), 0),
      },
      rest: {
        attempts: liveAttempts,
        filled: liveFills,
        fillRate: liveAttempts > 0 ? liveFills / liveAttempts : null,
        settled: live.filter((t) => t.netPnl != null).length,
        wins: live.filter((t) => (t.netPnl ?? 0) > 0 && t.netPnl != null).length,
        netPnl: live.filter((t) => t.netPnl != null).reduce((sum, t) => sum + (t.netPnl ?? 0), 0),
      },
    },
    rows,
  };
}

export function registerWsShadowRoutes(app: Express) {
  ensureShadowDefaults();
  if (!shadowTimer) scheduleShadow();

  app.get("/api/ws-shadow/status", (_req, res) => {
    res.json({
      enabled: shadowEnabled(),
      stream: kalshiProdStream.status(),
      openShadows: storage.getUnsettledWsShadowTrades().length,
    });
  });

  app.get("/api/ws-shadow/trades", (req, res) => {
    const limit = Math.min(500, Math.max(1, parseInt((req.query.limit as string) || "100", 10)));
    res.json({ trades: storage.getWsShadowTrades(limit) });
  });

  app.get("/api/ws-shadow/compare", (_req, res) => {
    res.json(buildComparison());
  });

  // Restart the experiment: wipe the shadow ledger (e.g. after a book-logic
  // fix invalidates old rows). Real trade ledgers are untouched.
  app.post("/api/ws-shadow/reset", (_req, res) => {
    const removed = storage.clearWsShadowTrades();
    res.json({ ok: true, removed });
  });

  app.post("/api/ws-shadow/toggle", (req, res) => {
    const enabled = req.body?.enabled === true || req.body?.enabled === "true";
    storage.setSetting("ws_shadow_enabled", String(enabled));
    if (!enabled) kalshiProdStream.setMarkets([]);
    res.json({ ok: true, enabled });
  });
}
