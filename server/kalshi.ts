import type { Express } from "express";
import { storage } from "./storage";

// Kalshi public market-data client. None of these endpoints need auth —
// RSA-signed requests are only required for portfolio/order endpoints,
// which land in Phase 2 against the demo environment.
const KALSHI_API = "https://external-api.kalshi.com/trade-api/v2";

export const KALSHI_CRYPTO_SERIES = [
  { ticker: "KXBTC15M", label: "Bitcoin up/down 15 min", cadenceMinutes: 15 },
  { ticker: "KXETH15M", label: "Ethereum up/down 15 min", cadenceMinutes: 15 },
  { ticker: "KXBTCD", label: "Bitcoin above/below hourly", cadenceMinutes: 60 },
  { ticker: "KXBTC", label: "Bitcoin range hourly", cadenceMinutes: 60 },
];

export type KalshiMarket = {
  ticker: string;
  event_ticker: string;
  title?: string;
  yes_sub_title?: string;
  status?: string;
  result?: string; // "yes" | "no" | "" until settled
  open_time?: string;
  close_time?: string;
  expected_expiration_time?: string;
  yes_bid_dollars?: string;
  yes_ask_dollars?: string;
  no_bid_dollars?: string;
  no_ask_dollars?: string;
  last_price_dollars?: string;
  volume_fp?: string;
  open_interest_fp?: string;
  floor_strike?: number;
  strike_type?: string;
};

export type KalshiCandle = {
  end_period_ts: number;
  volume_fp?: string;
  open_interest_fp?: string;
  price?: { open_dollars?: string; high_dollars?: string; low_dollars?: string; close_dollars?: string; mean_dollars?: string };
  yes_bid?: { open_dollars?: string; close_dollars?: string; high_dollars?: string; low_dollars?: string };
  yes_ask?: { open_dollars?: string; close_dollars?: string; high_dollars?: string; low_dollars?: string };
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function kalshiFetch(path: string, params?: Record<string, string>) {
  const url = new URL(`${KALSHI_API}${path}`);
  if (params) {
    Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
  }
  // Backtests fire many sequential requests; retry 429/5xx with backoff so a
  // rate-limit blip doesn't silently shrink the market sample.
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
    throw new Error(`Kalshi API error: ${res.status} ${res.statusText} for ${path}`);
  }
}

export function parseDollars(value?: string | null): number | null {
  if (value == null) return null;
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

// Kalshi's standard "quadratic" trading fee, rounded up to the next cent:
// fee = ceil(0.07 x contracts x price x (1 - price)). Both KXBTC15M and the
// hourly BTC series report fee_type=quadratic, fee_multiplier=1. This is
// charged per executed order (taker side), which is why edges that survived
// fee-free Polymarket paper trading need re-validation here.
export function kalshiTradingFee(contracts: number, price: number, feeMultiplier = 1) {
  if (!Number.isFinite(contracts) || contracts <= 0) return 0;
  const p = Math.min(0.99, Math.max(0.01, price));
  const raw = 0.07 * feeMultiplier * contracts * p * (1 - p);
  return Math.ceil(raw * 100) / 100;
}

export async function getKalshiMarkets(params: {
  seriesTicker?: string;
  status?: string;
  limit?: number;
  cursor?: string;
}) {
  const query: Record<string, string> = {
    limit: String(Math.min(200, Math.max(1, params.limit ?? 50))),
  };
  if (params.seriesTicker) query.series_ticker = params.seriesTicker;
  if (params.status) query.status = params.status;
  if (params.cursor) query.cursor = params.cursor;
  const data = await kalshiFetch("/markets", query) as { markets?: KalshiMarket[]; cursor?: string };
  return {
    markets: Array.isArray(data.markets) ? data.markets : [],
    cursor: data.cursor,
  };
}

export async function getKalshiMarket(ticker: string): Promise<KalshiMarket | null> {
  const data = await kalshiFetch(`/markets/${encodeURIComponent(ticker)}`) as { market?: KalshiMarket };
  return data.market ?? null;
}

export async function getKalshiOrderbook(ticker: string, depth = 10) {
  return kalshiFetch(`/markets/${encodeURIComponent(ticker)}/orderbook`, { depth: String(depth) });
}

// Short-TTL cache: many strategies evaluating the same market within the same
// few seconds (e.g. the prod-audition shadow) share one fetch instead of
// stampeding the rate-limited REST API. Keyed on a 10s end-time bucket.
const candleCache = new Map<string, { at: number; candles: KalshiCandle[] }>();

export async function getKalshiCandlesticks(
  seriesTicker: string,
  marketTicker: string,
  startTs: number,
  endTs: number,
  periodIntervalMinutes = 1,
) {
  const key = `${seriesTicker}|${marketTicker}|${periodIntervalMinutes}|${Math.floor(startTs / 60)}|${Math.floor(endTs / 10)}`;
  const cached = candleCache.get(key);
  if (cached && Date.now() - cached.at < 10_000) return cached.candles;

  const data = await kalshiFetch(
    `/series/${encodeURIComponent(seriesTicker)}/markets/${encodeURIComponent(marketTicker)}/candlesticks`,
    {
      start_ts: String(Math.floor(startTs)),
      end_ts: String(Math.floor(endTs)),
      period_interval: String(periodIntervalMinutes),
    },
  ) as { candlesticks?: KalshiCandle[] };
  const candles = Array.isArray(data.candlesticks) ? data.candlesticks : [];
  if (candleCache.size > 200) candleCache.clear();
  candleCache.set(key, { at: Date.now(), candles });
  return candles;
}

// ---------------------------------------------------------------------------
// Parameterized strategy specs — the search space the agent lab explores.
// Every spec is evaluated against real settled markets with a train/holdout
// time split so promoted strategies must generalize, not just curve-fit.
// ---------------------------------------------------------------------------

export type KalshiStrategySpec = {
  name: string;
  series: string;
  // "value": price the contract from the underlying settlement index
  // (distance to strike + time left + realized vol -> model probability) and
  // take whichever side the market underprices by >= minSignal.
  sideRule: "momentum" | "fade" | "always_yes" | "always_no" | "trend_follow" | "trend_fade" | "value";
  // How long before market close the entry decision is made.
  entrySecondsBeforeClose: number;
  // Only enter when the executable price of the chosen side is inside this band.
  minEntryPrice: number;
  maxEntryPrice: number;
  // For trend rules: how far back to measure the market-price move.
  trendLookbackMinutes: number;
  // Minimum signal strength: |price - 0.5| for momentum/fade, |move| for trend rules.
  minSignal: number;
  // Entry-time window in ET hours [minHourEt, maxHourEt). 0/24 = all day;
  // minHourEt > maxHourEt wraps overnight. Live forensics showed regime
  // structure by time of day, so hour-banding is a first-class, backtestable
  // strategy dimension rather than an executor hack.
  minHourEt: number;
  maxHourEt: number;
  orderSize: number;
};

const ET_HOUR_FMT = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false });
export function hourEt(ms: number): number {
  const h = parseInt(ET_HOUR_FMT.format(new Date(ms)), 10);
  return Number.isFinite(h) ? (h === 24 ? 0 : h) : 0;
}

export function hourInWindow(hour: number, minHour: number, maxHour: number): boolean {
  if (minHour === maxHour || (minHour === 0 && maxHour === 24)) return true;
  return minHour < maxHour
    ? hour >= minHour && hour < maxHour
    : hour >= minHour || hour < maxHour;
}

export const SPEC_SIDE_RULES = ["momentum", "fade", "always_yes", "always_no", "trend_follow", "trend_fade", "value"] as const;
export const SPEC_SERIES = ["KXBTC15M", "KXETH15M"] as const;

const clampNum = (value: unknown, min: number, max: number, fallback: number) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

// Agents propose specs as JSON; clamp everything into the legal search space
// rather than rejecting, so a slightly-out-of-range idea still gets tested.
export function clampSpec(raw: Record<string, unknown>): KalshiStrategySpec {
  const series = SPEC_SERIES.includes(raw.series as any) ? String(raw.series) : "KXBTC15M";
  const sideRule = SPEC_SIDE_RULES.includes(raw.sideRule as any)
    ? raw.sideRule as KalshiStrategySpec["sideRule"]
    : "momentum";
  const minEntry = clampNum(raw.minEntryPrice, 0.03, 0.97, 0.03);
  const maxEntry = clampNum(raw.maxEntryPrice, 0.03, 0.97, 0.97);
  return {
    name: String(raw.name || "unnamed").slice(0, 80),
    series,
    sideRule,
    entrySecondsBeforeClose: Math.round(clampNum(raw.entrySecondsBeforeClose, 60, 840, 300)),
    minEntryPrice: Math.min(minEntry, maxEntry),
    maxEntryPrice: Math.max(minEntry, maxEntry),
    trendLookbackMinutes: Math.round(clampNum(raw.trendLookbackMinutes, 1, 10, 3)),
    minSignal: clampNum(raw.minSignal, 0, 0.45, 0),
    minHourEt: Math.round(clampNum(raw.minHourEt, 0, 24, 0)),
    maxHourEt: Math.round(clampNum(raw.maxHourEt, 0, 24, 24)),
    orderSize: 10, // fixed so results stay comparable across candidates
  };
}

// Behavior-defining fields only — name/rationale don't affect results.
export function specHash(spec: KalshiStrategySpec) {
  return [
    spec.series, spec.sideRule, spec.entrySecondsBeforeClose,
    spec.minEntryPrice.toFixed(3), spec.maxEntryPrice.toFixed(3),
    spec.trendLookbackMinutes, spec.minSignal.toFixed(3),
    // Hour band joins the hash only when restrictive, so every pre-existing
    // stored hash (implicitly all-day) stays valid and still dedupes.
    ...(spec.minHourEt === spec.maxHourEt || (spec.minHourEt === 0 && spec.maxHourEt === 24)
      ? [] : [spec.minHourEt, spec.maxHourEt]),
  ].join("|");
}

export type SettledMarketData = {
  market: KalshiMarket;
  candles: KalshiCandle[];
  closeMs: number;
  // Underlying spot history for the window (minute closes; Coinbase proxy for
  // the CF index in backtests - live uses the real streamed index).
  spotValueAt?: (tsSec: number) => number | null;
};

// Abramowitz-Stegun normal CDF approximation - plenty for pricing 15-min binaries.
export function normalCdf(z: number): number {
  if (z < -8) return 0;
  if (z > 8) return 1;
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp(-z * z / 2);
  const p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z >= 0 ? 1 - p : p;
}

// Model probability that the index ends the window above the strike.
// Settlement is a 60s average ending at close, so effective time-to-settle
// is ~30s less than time-to-close. sigma floor keeps dead-calm periods from
// producing fake certainty.
export function valueModelProbUp(spot: number, strike: number, volPerSqrtSec: number, secondsToClose: number): number {
  const tSec = Math.max(5, secondsToClose - 30);
  const sigma = Math.max(spot * Math.max(volPerSqrtSec, 1e-6) * Math.sqrt(tSec), spot * 1e-5);
  return normalCdf((spot - strike) / sigma);
}

// --- Spot history for backtests: Coinbase minute candles, keyless & cached ---
const SPOT_PRODUCTS: Record<string, string> = { KXBTC15M: "BTC-USD", KXETH15M: "ETH-USD" };
const spotRangeCache = new Map<string, { at: number; closes: { ts: number; close: number }[] }>();

export async function fetchSpotMinuteCloses(series: string, startTsSec: number, endTsSec: number): Promise<{ ts: number; close: number }[]> {
  const product = SPOT_PRODUCTS[series];
  if (!product) return [];
  const key = `${product}|${Math.floor(startTsSec / 600)}|${Math.floor(endTsSec / 600)}`;
  const cached = spotRangeCache.get(key);
  if (cached && Date.now() - cached.at < 10 * 60_000) return cached.closes;

  const closes: { ts: number; close: number }[] = [];
  // Coinbase caps 300 candles per request; page through the range.
  for (let cursor = startTsSec; cursor < endTsSec; cursor += 300 * 60) {
    const chunkEnd = Math.min(endTsSec, cursor + 300 * 60);
    try {
      const res = await fetch(
        `https://api.exchange.coinbase.com/products/${product}/candles?granularity=60` +
        `&start=${new Date(cursor * 1000).toISOString()}&end=${new Date(chunkEnd * 1000).toISOString()}`,
        { headers: { "User-Agent": "polybot-research" } },
      );
      if (!res.ok) continue;
      const rows = await res.json() as [number, number, number, number, number, number][];
      for (const row of rows) {
        if (Array.isArray(row) && row.length >= 5) closes.push({ ts: row[0], close: row[4] });
      }
      await sleep(150);
    } catch {
      continue;
    }
  }
  closes.sort((a, b) => a.ts - b.ts);
  if (spotRangeCache.size > 20) spotRangeCache.clear();
  spotRangeCache.set(key, { at: Date.now(), closes });
  return closes;
}

function makeSpotLookup(closes: { ts: number; close: number }[]): (tsSec: number) => number | null {
  return (tsSec: number) => {
    // Latest minute close at or before ts (candle ts = bucket start, so the
    // close is known at ts+60; use the bucket covering ts-60 for causality).
    let best: { ts: number; close: number } | null = null;
    for (const c of closes) {
      if (c.ts + 60 <= tsSec + 1 && (!best || c.ts > best.ts)) best = c;
    }
    return best && tsSec - best.ts < 15 * 60 ? best.close : null;
  };
}

// Fetch settled markets and their 1-min candles ONCE, then evaluate any number
// of specs in memory. Candle fetches dominate cycle latency, so reuse matters.
export async function fetchSettledMarketData(series: string, lookback: number): Promise<SettledMarketData[]> {
  const settled: KalshiMarket[] = [];
  let cursor: string | undefined;
  while (settled.length < lookback) {
    const page = await getKalshiMarkets({ seriesTicker: series, status: "settled", limit: 100, cursor });
    settled.push(...page.markets.filter((m) => m.result === "yes" || m.result === "no"));
    if (!page.cursor || page.markets.length === 0) break;
    cursor = page.cursor;
  }

  const data: SettledMarketData[] = [];
  for (const market of settled.slice(0, lookback)) {
    try {
      const closeMs = market.close_time ? new Date(market.close_time).getTime() : NaN;
      if (!Number.isFinite(closeMs)) continue;
      const openMs = market.open_time ? new Date(market.open_time).getTime() : closeMs - 3600_000;
      const candles = await getKalshiCandlesticks(
        series, market.ticker,
        Math.floor(openMs / 1000), Math.floor(closeMs / 1000), 1,
      );
      if (candles.length > 0) data.push({ market, candles, closeMs });
      // Pace sequential candle fetches so the whole sweep stays under the
      // public API rate limit instead of tripping 429s halfway through.
      await sleep(120);
    } catch {
      continue;
    }
  }
  // Attach underlying spot history (one range fetch shared by all windows) so
  // "value" specs can be evaluated like any other rule.
  if (data.length > 0) {
    try {
      const startSec = Math.min(...data.map((d) => Math.floor(d.closeMs / 1000))) - 3600;
      const endSec = Math.max(...data.map((d) => Math.floor(d.closeMs / 1000))) + 60;
      const closes = await fetchSpotMinuteCloses(series, startSec, endSec);
      if (closes.length > 10) {
        const lookup = makeSpotLookup(closes);
        for (const entry of data) entry.spotValueAt = lookup;
      }
    } catch { /* value specs simply skip windows without spot data */ }
  }

  // Oldest first so the train/holdout split is chronological.
  return data.sort((a, b) => a.closeMs - b.closeMs);
}

type SpecTrade = { ticker: string; side: "YES" | "NO"; entryPrice: number; fee: number; won: boolean; netPnl: number };

function evaluateSpecOnMarket(spec: KalshiStrategySpec, entry: SettledMarketData): SpecTrade | null {
  const entryTs = Math.floor(entry.closeMs / 1000) - spec.entrySecondsBeforeClose;
  if (!hourInWindow(hourEt(entryTs * 1000), spec.minHourEt, spec.maxHourEt)) return null;
  const sorted = [...entry.candles].sort((a, b) => a.end_period_ts - b.end_period_ts);
  const entryCandle = [...sorted].reverse().find((c) => c.end_period_ts <= entryTs);
  if (!entryCandle) return null;

  const yesAsk = parseDollars(entryCandle.yes_ask?.close_dollars);
  const yesBid = parseDollars(entryCandle.yes_bid?.close_dollars);
  const marketPrice = parseDollars(entryCandle.price?.close_dollars) ?? yesAsk;
  if (yesAsk == null || yesBid == null || marketPrice == null) return null;

  let side: "YES" | "NO" | null = null;
  if (spec.sideRule === "always_yes") side = "YES";
  else if (spec.sideRule === "always_no") side = "NO";
  else if (spec.sideRule === "momentum" || spec.sideRule === "fade") {
    if (Math.abs(marketPrice - 0.5) < spec.minSignal) return null;
    const favored: "YES" | "NO" = marketPrice >= 0.5 ? "YES" : "NO";
    side = spec.sideRule === "momentum" ? favored : favored === "YES" ? "NO" : "YES";
  } else if (spec.sideRule === "value") {
    if (!entry.spotValueAt || !entry.market.open_time) return null;
    const openTs = Math.floor(new Date(entry.market.open_time).getTime() / 1000);
    const strike = entry.spotValueAt(openTs);
    const spot = entry.spotValueAt(entryTs);
    if (strike == null || spot == null) return null;
    // 30-min realized vol from minute closes (fixed window on both the
    // backtest and live paths so the two agree).
    const rets: number[] = [];
    let prev: number | null = null;
    for (let k = 30; k >= 0; k--) {
      const v = entry.spotValueAt(entryTs - k * 60);
      if (v != null && prev != null) rets.push(Math.log(v / prev));
      if (v != null) prev = v;
    }
    if (rets.length < 15) return null;
    const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
    const volPerSqrtSec = Math.sqrt(rets.reduce((a, r) => a + (r - mean) ** 2, 0) / rets.length) / Math.sqrt(60);
    const pUp = valueModelProbUp(spot, strike, volPerSqrtSec, spec.entrySecondsBeforeClose);
    const edgeThreshold = Math.max(spec.minSignal, 0.02);
    const edgeYes = pUp - yesAsk;
    const edgeNo = yesBid - pUp; // buying NO at 1-yesBid pays off with prob 1-pUp
    if (edgeYes >= edgeThreshold && edgeYes >= edgeNo) side = "YES";
    else if (edgeNo >= edgeThreshold) side = "NO";
    else return null;
  } else {
    const lookbackTs = entryTs - spec.trendLookbackMinutes * 60;
    const pastCandle = [...sorted].reverse().find((c) => c.end_period_ts <= lookbackTs);
    const pastPrice = pastCandle ? parseDollars(pastCandle.price?.close_dollars) : null;
    if (pastPrice == null) return null;
    const move = marketPrice - pastPrice;
    if (Math.abs(move) < spec.minSignal) return null;
    const trendSide: "YES" | "NO" = move >= 0 ? "YES" : "NO";
    side = spec.sideRule === "trend_follow" ? trendSide : trendSide === "YES" ? "NO" : "YES";
  }
  if (!side) return null;

  const entryPrice = side === "YES" ? yesAsk : 1 - yesBid;
  if (entryPrice < spec.minEntryPrice || entryPrice > spec.maxEntryPrice) return null;
  if (entryPrice <= 0.01 || entryPrice >= 0.99) return null;

  const contracts = spec.orderSize / entryPrice;
  const fee = kalshiTradingFee(contracts, entryPrice);
  const won = (side === "YES" && entry.market.result === "yes") || (side === "NO" && entry.market.result === "no");
  const payout = won ? contracts : 0;
  return { ticker: entry.market.ticker, side, entryPrice, fee, won, netPnl: payout - spec.orderSize - fee };
}

export type SpecSampleResult = {
  trades: number;
  wins: number;
  winRate: number;
  netPnl: number;
  totalFees: number;
  avgEdgePct: number; // avg net pnl per trade as % of stake
};

function summarizeTrades(trades: SpecTrade[], orderSize: number): SpecSampleResult {
  const wins = trades.filter((t) => t.won).length;
  const netPnl = trades.reduce((sum, t) => sum + t.netPnl, 0);
  const totalFees = trades.reduce((sum, t) => sum + t.fee, 0);
  return {
    trades: trades.length,
    wins,
    winRate: trades.length > 0 ? wins / trades.length : 0,
    netPnl,
    totalFees,
    avgEdgePct: trades.length > 0 ? (netPnl / trades.length / orderSize) * 100 : 0,
  };
}

// Flat evaluation over a market subset — used for walk-forward testing, where
// each cycle scores surviving candidates only on markets that settled since
// their last evaluation, so live evidence accumulates instead of resetting.
export function evaluateSpecSample(spec: KalshiStrategySpec, data: SettledMarketData[]): SpecSampleResult {
  const trades: SpecTrade[] = [];
  for (const entry of data) {
    const trade = evaluateSpecOnMarket(spec, entry);
    if (trade) trades.push(trade);
  }
  return summarizeTrades(trades, spec.orderSize);
}

export function evaluateSpecOnData(spec: KalshiStrategySpec, data: SettledMarketData[]) {
  // Chronological split: older half trains, newer half is the honesty check.
  const splitIndex = Math.floor(data.length / 2);
  const trainTrades: SpecTrade[] = [];
  const holdoutTrades: SpecTrade[] = [];
  for (let i = 0; i < data.length; i++) {
    const trade = evaluateSpecOnMarket(spec, data[i]);
    if (!trade) continue;
    (i < splitIndex ? trainTrades : holdoutTrades).push(trade);
  }
  return {
    train: summarizeTrades(trainTrades, spec.orderSize),
    holdout: summarizeTrades(holdoutTrades, spec.orderSize),
    marketsScanned: data.length,
    sampleTrades: [...trainTrades, ...holdoutTrades].slice(0, 10),
  };
}

type KalshiBacktestTrade = {
  ticker: string;
  side: "YES" | "NO";
  entryPrice: number;
  contracts: number;
  fee: number;
  result: string;
  won: boolean;
  netPnl: number;
};

// Replays real settled Kalshi markets: entry at the actual quoted ask N
// seconds before close, settlement at the market's real result. Unlike the
// Polymarket backtest (which synthesizes prices from spot deltas), every
// number here was a live tradeable quote.
export async function runKalshiBacktest(options: {
  series?: string;
  marketsLookback?: number;
  entrySecondsBeforeClose?: number;
  strategy?: "momentum" | "fade";
  orderSize?: number;
}) {
  const series = options.series ?? "KXBTC15M";
  const lookback = Math.min(100, Math.max(5, options.marketsLookback ?? 40));
  const entrySecondsBeforeClose = Math.min(3600, Math.max(60, options.entrySecondsBeforeClose ?? 300));
  const strategy = options.strategy === "fade" ? "fade" : "momentum";
  const orderSize = Math.max(1, options.orderSize ?? 10);

  const settled: KalshiMarket[] = [];
  let cursor: string | undefined;
  while (settled.length < lookback) {
    const page = await getKalshiMarkets({ seriesTicker: series, status: "settled", limit: 100, cursor });
    settled.push(...page.markets.filter((m) => m.result === "yes" || m.result === "no"));
    if (!page.cursor || page.markets.length === 0) break;
    cursor = page.cursor;
  }
  const sample = settled.slice(0, lookback);

  const trades: KalshiBacktestTrade[] = [];
  let skipped = 0;

  for (const market of sample) {
    try {
      const closeMs = market.close_time ? new Date(market.close_time).getTime() : NaN;
      const openMs = market.open_time ? new Date(market.open_time).getTime() : closeMs - 3600_000;
      if (!Number.isFinite(closeMs)) {
        skipped += 1;
        continue;
      }
      const entryTs = Math.floor(closeMs / 1000) - entrySecondsBeforeClose;
      const candles = await getKalshiCandlesticks(
        series,
        market.ticker,
        Math.floor(openMs / 1000),
        Math.floor(closeMs / 1000),
        1,
      );
      // Latest candle that completed at or before the entry moment.
      const entryCandle = [...candles]
        .filter((c) => c.end_period_ts <= entryTs)
        .sort((a, b) => b.end_period_ts - a.end_period_ts)[0];
      if (!entryCandle) {
        skipped += 1;
        continue;
      }

      const yesAsk = parseDollars(entryCandle.yes_ask?.close_dollars);
      const yesBid = parseDollars(entryCandle.yes_bid?.close_dollars);
      const marketPrice = parseDollars(entryCandle.price?.close_dollars) ?? yesAsk;
      if (yesAsk == null || yesBid == null || marketPrice == null) {
        skipped += 1;
        continue;
      }

      // momentum = back the side the market currently favors; fade = opposite.
      const favoredSide: "YES" | "NO" = marketPrice >= 0.5 ? "YES" : "NO";
      const side: "YES" | "NO" = strategy === "momentum"
        ? favoredSide
        : favoredSide === "YES" ? "NO" : "YES";

      // Executable entry: YES buys at the yes ask; NO buys at (1 - yes bid).
      const entryPrice = side === "YES" ? yesAsk : 1 - yesBid;
      // Skip quotes so extreme there is no realistic fill or payoff.
      if (entryPrice <= 0.03 || entryPrice >= 0.97) {
        skipped += 1;
        continue;
      }

      const contracts = orderSize / entryPrice;
      const fee = kalshiTradingFee(contracts, entryPrice);
      const won = (side === "YES" && market.result === "yes") || (side === "NO" && market.result === "no");
      const payout = won ? contracts : 0;
      const netPnl = payout - orderSize - fee;
      trades.push({
        ticker: market.ticker,
        side,
        entryPrice,
        contracts,
        fee,
        result: market.result ?? "",
        won,
        netPnl,
      });
    } catch {
      skipped += 1;
      continue;
    }
  }

  const wins = trades.filter((t) => t.won).length;
  const losses = trades.length - wins;
  const grossPnl = trades.reduce((sum, t) => sum + t.netPnl + t.fee, 0);
  const totalFees = trades.reduce((sum, t) => sum + t.fee, 0);
  const netPnl = grossPnl - totalFees;
  const winRate = trades.length > 0 ? wins / trades.length : 0;
  const avgEdge = trades.length > 0 ? netPnl / trades.length : 0;
  const edgePct = orderSize > 0 ? (avgEdge / orderSize) * 100 : 0;

  const run = storage.saveBacktestRun({
    strategyName: `Kalshi ${series} ${strategy} T-${entrySecondsBeforeClose}s`,
    ranAt: new Date().toISOString(),
    periodDays: 0,
    totalTrades: trades.length,
    wins,
    losses,
    winRate,
    grossPnl,
    totalFees,
    netPnl,
    edgePct,
    meetsTarget: winRate >= 0.55 && edgePct >= 0.5,
  });

  return {
    run,
    settledMarketsScanned: sample.length,
    skipped,
    trades: trades.slice(0, 50),
  };
}

export function registerKalshiRoutes(app: Express) {
  app.get("/api/kalshi/series", (_req, res) => {
    res.json(KALSHI_CRYPTO_SERIES);
  });

  app.get("/api/kalshi/markets", async (req, res) => {
    try {
      const data = await getKalshiMarkets({
        seriesTicker: (req.query.series as string) || "KXBTC15M",
        status: (req.query.status as string) || "open",
        limit: parseInt((req.query.limit as string) || "50", 10),
        cursor: req.query.cursor as string | undefined,
      });
      res.json(data);
    } catch (e: any) {
      res.status(502).json({ error: e.message });
    }
  });

  app.get("/api/kalshi/orderbook/:ticker", async (req, res) => {
    try {
      const depth = parseInt((req.query.depth as string) || "10", 10);
      res.json(await getKalshiOrderbook(req.params.ticker, depth));
    } catch (e: any) {
      res.status(502).json({ error: e.message });
    }
  });

  app.get("/api/kalshi/candles", async (req, res) => {
    try {
      const series = (req.query.series as string) || "KXBTC15M";
      const ticker = req.query.ticker as string;
      if (!ticker) {
        res.status(400).json({ error: "ticker query param required" });
        return;
      }
      const nowSec = Math.floor(Date.now() / 1000);
      const startTs = parseInt((req.query.startTs as string) || String(nowSec - 3600), 10);
      const endTs = parseInt((req.query.endTs as string) || String(nowSec), 10);
      const interval = parseInt((req.query.interval as string) || "1", 10);
      res.json({ candlesticks: await getKalshiCandlesticks(series, ticker, startTs, endTs, interval) });
    } catch (e: any) {
      res.status(502).json({ error: e.message });
    }
  });

  app.post("/api/kalshi/spec-backtest", async (req, res) => {
    try {
      const spec = clampSpec(req.body ?? {});
      const lookback = Math.min(150, Math.max(10, Number(req.body?.marketsLookback ?? 60)));
      const data = await fetchSettledMarketData(spec.series, lookback);
      if (data.length < 10) {
        res.status(502).json({ error: `Only ${data.length} settled markets with candles available` });
        return;
      }
      res.json({ spec, specHash: specHash(spec), ...evaluateSpecOnData(spec, data) });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/kalshi/backtest", async (req, res) => {
    try {
      const result = await runKalshiBacktest({
        series: req.body?.series,
        marketsLookback: req.body?.marketsLookback,
        entrySecondsBeforeClose: req.body?.entrySecondsBeforeClose,
        strategy: req.body?.strategy,
        orderSize: req.body?.orderSize,
      });
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });
}
