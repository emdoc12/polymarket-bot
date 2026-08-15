import type { Express } from "express";
import { storage } from "./storage";

// Kalshi perpetual futures ("margin") data client, strategy grammar, and
// real-candle backtester. Perps are the one crypto venue where the DEMO
// exchange has seeded, deep liquidity - so unlike the binary event markets,
// perp strategies can be validated end to end (real fills) with demo money.
//
// API surface mirrors the event-contract API under /margin: same auth, same
// fixed-point strings. bid = long, ask = short. Contract prices are scaled
// index units (e.g. KXBTCPERP1 ~ BTC/10,000), fractional contracts to 0.01.

const PERPS_API = process.env.KALSHI_PERPS_API_BASE || "https://external-api.demo.kalshi.co/trade-api/v2";

export const PERP_MARKETS = ["KXBTCPERP1", "KXETHPERP1"] as const;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function perpsFetch(path: string, params?: Record<string, string>) {
  const url = new URL(`${PERPS_API}${path}`);
  if (params) Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url.toString(), {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10000),
    });
    if (res.ok) return res.json();
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      const retryAfterSec = parseFloat(res.headers.get("retry-after") || "0");
      await sleep(Math.max(retryAfterSec * 1000, 500 * Math.pow(2, attempt)));
      continue;
    }
    throw new Error(`Kalshi perps API error: ${res.status} ${res.statusText} for ${path}`);
  }
}

export function parsePerpDollars(value: unknown): number | null {
  const parsed = parseFloat(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : null;
}

export type PerpCandle = {
  end_period_ts: number;
  price?: { open?: string; high?: string; low?: string; close?: string; mean?: string };
  bid?: { open?: string; high?: string; low?: string; close?: string };
  ask?: { open?: string; high?: string; low?: string; close?: string };
  volume?: string;
};

export async function getPerpMarkets() {
  const data = await perpsFetch("/margin/markets") as { markets?: any[] };
  return Array.isArray(data.markets) ? data.markets : [];
}

export async function getPerpOrderbook(ticker: string, depth = 5) {
  const data = await perpsFetch(`/margin/markets/${encodeURIComponent(ticker)}/orderbook`, { depth: String(depth) });
  return data?.orderbook ?? { bids: [], asks: [] };
}

// Top of book as {bid, ask} in dollars; levels arrive as [price, size] tuples
// sorted with best last per Kalshi convention - so scan for best explicitly.
export async function getPerpTopOfBook(ticker: string): Promise<{ bid: number | null; ask: number | null }> {
  const book = await getPerpOrderbook(ticker, 10);
  const prices = (levels: unknown[], pick: "max" | "min") => {
    const parsed = (Array.isArray(levels) ? levels : [])
      .map((level: any) => parsePerpDollars(level?.[0]))
      .filter((p): p is number => p != null && p > 0);
    if (parsed.length === 0) return null;
    return pick === "max" ? Math.max(...parsed) : Math.min(...parsed);
  };
  return { bid: prices(book.bids, "max"), ask: prices(book.asks, "min") };
}

export async function getPerpFundingEstimate(ticker: string) {
  return perpsFetch("/margin/funding_rates/estimate", { ticker });
}

export async function getPerpCandles(ticker: string, startTs: number, endTs: number, periodInterval = 1): Promise<PerpCandle[]> {
  const data = await perpsFetch(
    `/margin/markets/${encodeURIComponent(ticker)}/candlesticks`,
    { start_ts: String(Math.floor(startTs)), end_ts: String(Math.floor(endTs)), period_interval: String(periodInterval) },
  ) as { candlesticks?: PerpCandle[] };
  return Array.isArray(data.candlesticks) ? data.candlesticks : [];
}

// Chunked history fetch (the API caps ~5000 candles per request).
export async function fetchPerpCandleHistory(ticker: string, hours: number): Promise<PerpCandle[]> {
  const endTs = Math.floor(Date.now() / 1000);
  const startTs = endTs - Math.floor(hours * 3600);
  const chunkSec = 4000 * 60; // 4000 one-minute candles per request
  const all: PerpCandle[] = [];
  for (let from = startTs; from < endTs; from += chunkSec) {
    const to = Math.min(from + chunkSec, endTs);
    const chunk = await getPerpCandles(ticker, from, to, 1);
    all.push(...chunk);
    await sleep(120);
  }
  const seen = new Set<number>();
  return all
    .filter((c) => {
      if (seen.has(c.end_period_ts)) return false;
      seen.add(c.end_period_ts);
      return true;
    })
    .sort((a, b) => a.end_period_ts - b.end_period_ts);
}

// ---------------------------------------------------------------------------
// Strategy grammar
// ---------------------------------------------------------------------------

export type PerpStrategySpec = {
  name: string;
  market: string;
  direction: "trend_follow" | "trend_fade";
  lookbackMinutes: number;     // signal window
  entryThresholdPct: number;   // min |move| over lookback to trigger, in percent
  takeProfitPct: number;       // exit at +/- percent from entry
  stopLossPct: number;
  maxHoldMinutes: number;      // time stop (kept short: funding not modeled)
  notional: number;            // fixed $ notional per trade for comparability
};

const clampNum = (value: unknown, min: number, max: number, fallback: number) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

export function clampPerpSpec(raw: Record<string, unknown>): PerpStrategySpec {
  const market = PERP_MARKETS.includes(raw.market as any) ? String(raw.market) : "KXBTCPERP1";
  return {
    name: String(raw.name || "unnamed-perp").slice(0, 80),
    market,
    direction: raw.direction === "trend_fade" ? "trend_fade" : "trend_follow",
    lookbackMinutes: Math.round(clampNum(raw.lookbackMinutes, 3, 120, 15)),
    entryThresholdPct: clampNum(raw.entryThresholdPct, 0.02, 2, 0.15),
    takeProfitPct: clampNum(raw.takeProfitPct, 0.05, 3, 0.4),
    stopLossPct: clampNum(raw.stopLossPct, 0.05, 3, 0.3),
    maxHoldMinutes: Math.round(clampNum(raw.maxHoldMinutes, 5, 180, 60)),
    notional: 50,
  };
}

export function perpSpecHash(spec: PerpStrategySpec) {
  return [
    "perp", spec.market, spec.direction, spec.lookbackMinutes,
    spec.entryThresholdPct.toFixed(3), spec.takeProfitPct.toFixed(3),
    spec.stopLossPct.toFixed(3), spec.maxHoldMinutes,
  ].join("|");
}

export function getPerpTakerFeeRate() {
  const raw = parseFloat(storage.getSetting("perp_taker_fee_rate") || "0.0012");
  return Number.isFinite(raw) && raw >= 0 ? raw : 0.0012;
}

// ---------------------------------------------------------------------------
// Backtester - replays real 1-minute candles with bid/ask execution realism:
// longs enter at the ask and exit at the bid, shorts the reverse. Intrabar
// exits are conservative: if both stop and target were touched in the same
// bar, the stop is assumed to have hit first. Funding is not modeled; the
// grammar caps holds at 3h to keep that omission small.
// ---------------------------------------------------------------------------

type PerpTrade = { entryTs: number; side: "long" | "short"; entry: number; exit: number; exitReason: string; netPnl: number; fees: number };

export type PerpSampleResult = {
  trades: number;
  wins: number;
  winRate: number;
  netPnl: number;
  totalFees: number;
  avgEdgePct: number;
};

function summarizePerpTrades(trades: PerpTrade[], notional: number): PerpSampleResult {
  const wins = trades.filter((t) => t.netPnl > 0).length;
  const netPnl = trades.reduce((s, t) => s + t.netPnl, 0);
  const totalFees = trades.reduce((s, t) => s + t.fees, 0);
  return {
    trades: trades.length,
    wins,
    winRate: trades.length > 0 ? wins / trades.length : 0,
    netPnl,
    totalFees,
    avgEdgePct: trades.length > 0 ? (netPnl / trades.length / notional) * 100 : 0,
  };
}

export function runPerpTradesOnCandles(spec: PerpStrategySpec, candles: PerpCandle[]): PerpTrade[] {
  const feeRate = getPerpTakerFeeRate();
  const px = candles.map((c) => ({
    ts: c.end_period_ts,
    close: parsePerpDollars(c.price?.close),
    bidClose: parsePerpDollars(c.bid?.close),
    bidLow: parsePerpDollars(c.bid?.low),
    bidHigh: parsePerpDollars(c.bid?.high),
    askClose: parsePerpDollars(c.ask?.close),
    askLow: parsePerpDollars(c.ask?.low),
    askHigh: parsePerpDollars(c.ask?.high),
  }));

  const trades: PerpTrade[] = [];
  let pos: { side: "long" | "short"; entry: number; entryTs: number; entryIndex: number; contracts: number } | null = null;

  for (let i = spec.lookbackMinutes; i < px.length; i++) {
    const bar = px[i];
    if (bar.close == null) continue;

    if (pos) {
      const heldMinutes = (bar.ts - pos.entryTs) / 60;
      let exit: number | null = null;
      let reason = "";
      if (pos.side === "long") {
        const sl = pos.entry * (1 - spec.stopLossPct / 100);
        const tp = pos.entry * (1 + spec.takeProfitPct / 100);
        if (bar.bidLow != null && bar.bidLow <= sl) { exit = sl; reason = "stop_loss"; }
        else if (bar.bidHigh != null && bar.bidHigh >= tp) { exit = tp; reason = "take_profit"; }
        else if (heldMinutes >= spec.maxHoldMinutes && bar.bidClose != null) { exit = bar.bidClose; reason = "time_stop"; }
      } else {
        const sl = pos.entry * (1 + spec.stopLossPct / 100);
        const tp = pos.entry * (1 - spec.takeProfitPct / 100);
        if (bar.askHigh != null && bar.askHigh >= sl) { exit = sl; reason = "stop_loss"; }
        else if (bar.askLow != null && bar.askLow <= tp) { exit = tp; reason = "take_profit"; }
        else if (heldMinutes >= spec.maxHoldMinutes && bar.askClose != null) { exit = bar.askClose; reason = "time_stop"; }
      }
      if (exit != null) {
        const gross = pos.side === "long"
          ? pos.contracts * (exit - pos.entry)
          : pos.contracts * (pos.entry - exit);
        const fees = spec.notional * feeRate + pos.contracts * exit * feeRate;
        trades.push({ entryTs: pos.entryTs, side: pos.side, entry: pos.entry, exit, exitReason: reason, netPnl: gross - fees, fees });
        pos = null;
      }
      continue;
    }

    const past = px[i - spec.lookbackMinutes];
    if (past?.close == null || past.close <= 0) continue;
    const movePct = ((bar.close - past.close) / past.close) * 100;
    if (Math.abs(movePct) < spec.entryThresholdPct) continue;

    const trendSide: "long" | "short" = movePct >= 0 ? "long" : "short";
    const side = spec.direction === "trend_follow" ? trendSide : trendSide === "long" ? "short" : "long";
    const entry = side === "long" ? bar.askClose : bar.bidClose;
    if (entry == null || entry <= 0) continue;
    pos = { side, entry, entryTs: bar.ts, entryIndex: i, contracts: spec.notional / entry };
  }

  return trades;
}

export function evaluatePerpSpecOnCandles(spec: PerpStrategySpec, candles: PerpCandle[]) {
  const splitIndex = Math.floor(candles.length / 2);
  const splitTs = candles[splitIndex]?.end_period_ts ?? 0;
  const trades = runPerpTradesOnCandles(spec, candles);
  const trainTrades = trades.filter((t) => t.entryTs < splitTs);
  const holdoutTrades = trades.filter((t) => t.entryTs >= splitTs);
  return {
    train: summarizePerpTrades(trainTrades, spec.notional),
    holdout: summarizePerpTrades(holdoutTrades, spec.notional),
    candlesUsed: candles.length,
    sampleTrades: trades.slice(-10),
  };
}

// Walk-forward slice: score only on candles newer than sinceTs.
export function evaluatePerpSpecSample(spec: PerpStrategySpec, candles: PerpCandle[], sinceTs: number): PerpSampleResult {
  // Include lookback context before the boundary so early signals are valid.
  const startIndex = Math.max(0, candles.findIndex((c) => c.end_period_ts > sinceTs) - spec.lookbackMinutes);
  const slice = candles.slice(startIndex === -1 ? candles.length : startIndex);
  const trades = runPerpTradesOnCandles(spec, slice).filter((t) => t.entryTs > sinceTs);
  return summarizePerpTrades(trades, spec.notional);
}

export function registerPerpsRoutes(app: Express) {
  if (!storage.getSetting("perp_taker_fee_rate")) storage.setSetting("perp_taker_fee_rate", "0.0012");

  app.get("/api/perps/markets", async (_req, res) => {
    try {
      const markets = await getPerpMarkets();
      const enriched = await Promise.all(PERP_MARKETS.map(async (ticker) => {
        const market = markets.find((m: any) => m.ticker === ticker);
        let funding: any = null;
        try { funding = await getPerpFundingEstimate(ticker); } catch { /* optional */ }
        return {
          ticker,
          markPrice: funding?.mark_price ?? null,
          fundingRate: funding?.funding_rate ?? null,
          nextFundingTime: funding?.next_funding_time ?? null,
          volume24h: market?.volume_24h_fp ?? market?.volume_fp ?? null,
          openInterest: market?.open_interest_fp ?? market?.open_interest ?? null,
        };
      }));
      res.json({ markets: enriched });
    } catch (e: any) {
      res.status(502).json({ error: e.message });
    }
  });

  app.post("/api/perps/spec-backtest", async (req, res) => {
    try {
      const spec = clampPerpSpec(req.body ?? {});
      const hours = Math.min(168, Math.max(6, Number(req.body?.hours ?? 72)));
      const candles = await fetchPerpCandleHistory(spec.market, hours);
      if (candles.length < 120) {
        res.status(502).json({ error: `Only ${candles.length} candles available for ${spec.market}` });
        return;
      }
      res.json({ spec, specHash: perpSpecHash(spec), ...evaluatePerpSpecOnCandles(spec, candles) });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });
}
