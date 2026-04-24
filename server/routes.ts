import type { Express } from "express";
import { type Server } from "http";
import { storage } from "./storage";
import { insertStrategySchema, insertWatchlistSchema, type Strategy, type TradeLog } from "@shared/schema";

const GAMMA_API = "https://gamma-api.polymarket.com";
const CLOB_API = "https://clob.polymarket.com";

type PolyMarket = {
  id: string;
  question?: string;
  conditionId?: string;
  clobTokenIds?: string | null;
  outcomePrices?: string | null;
  outcomes?: string | null;
  startDate?: string;
  endDate?: string;
  active?: boolean;
  closed?: boolean;
  image?: string;
  slug?: string;
  volume?: string;
  volumeNum?: number;
  _eventTitle?: string;
  _eventImage?: string;
};

type PolyEvent = {
  id: string;
  title?: string;
  image?: string;
  startDate?: string;
  endDate?: string;
  volume?: string;
  markets?: PolyMarket[];
};

type PriceSnapshot = {
  yesTokenId: string | null;
  noTokenId: string | null;
  yesMid: number | null;
  noMid: number | null;
  yesBook: any | null;
  noBook: any | null;
};

type EngineRuntimeState = {
  running: boolean;
  lastPollAt: string | null;
  lastPollOutcome: string | null;
  lastSignalAt: string | null;
  lastSignalStrategy: string | null;
  lastSignalReason: string | null;
  currentMarketId: string | null;
  currentConditionId: string | null;
  currentMarketQuestion: string | null;
  currentMarketEndsAt: string | null;
  currentYesPrice: number | null;
  currentNoPrice: number | null;
  openTrades: number;
  strategyDiagnostics: {
    strategyId: number;
    strategyName: string;
    outcome: string;
    detail: string;
    score: number | null;
    checkedAt: string | null;
  }[];
  managerDecision: {
    chosenStrategyId: number | null;
    chosenStrategyName: string | null;
    action: string | null;
    side: "YES" | "NO" | null;
    score: number | null;
    reason: string | null;
    decidedAt: string | null;
  };
  marketDebug: {
    matchedEventTitles: string[];
    btcCandidateTitles: string[];
  };
};

const FIXED_STRATEGIES = [
  {
    name: "Last-Second Momentum Snipe",
    marketQuestion: "Bitcoin Up or Down - 5 Minutes (auto-roll)",
    side: "YES" as const,
    triggerType: "price_below",
    triggerPrice: 0.48,
    orderSize: 10,
    orderType: "MARKET",
    cooldownMinutes: 1,
    isActive: false,
    autoRoll: true,
    config: JSON.stringify({
      triggerPrice: 0.48,
      orderSize: 10,
      momentumThreshold: 0.65,
      minSecondsLeft: 45,
      description: "Buy YES when the BTC candle is still underpriced during late positive momentum.",
    }),
  },
  {
    name: "Orderbook Arbitrage & Imbalance",
    marketQuestion: "Bitcoin Up or Down - 5 Minutes (auto-roll)",
    side: "YES" as const,
    triggerType: "price_above",
    triggerPrice: 0,
    orderSize: 10,
    orderType: "MARKET",
    cooldownMinutes: 1,
    isActive: false,
    autoRoll: true,
    config: JSON.stringify({
      orderSize: 10,
      imbalanceThreshold: 0.18,
      maxEntryPrice: 0.56,
      minSecondsLeft: 40,
      description: "Trade when the BTC 5-minute YES/NO books diverge from fair value and one side is still cheap.",
    }),
  },
  {
    name: "Spot Correlation Reversion Scalp",
    marketQuestion: "Bitcoin Up or Down - 5 Minutes (auto-roll)",
    side: "YES" as const,
    triggerType: "price_below",
    triggerPrice: 0.45,
    orderSize: 10,
    orderType: "MARKET",
    cooldownMinutes: 1,
    isActive: false,
    autoRoll: true,
    config: JSON.stringify({
      triggerPrice: 0.46,
      orderSize: 10,
      reboundThreshold: 0.0025,
      windowBars: 8,
      minSecondsLeft: 60,
      description: "Buy YES after a BTC rebound when the Polymarket YES price still lags spot.",
    }),
  },
  {
    name: "Oracle Lead Arbitrage",
    marketQuestion: "Bitcoin Up or Down - 5 Minutes (auto-roll)",
    side: "YES" as const,
    triggerType: "price_above",
    triggerPrice: 0,
    orderSize: 10,
    orderType: "MARKET",
    cooldownMinutes: 1,
    isActive: false,
    autoRoll: true,
    config: JSON.stringify({
      orderSize: 10,
      spotMoveThreshold: 0.002,
      maxEntryPrice: 0.6,
      minSecondsLeft: 75,
      description: "Follow BTC spot when the 5-minute market is still lagging the latest move.",
    }),
  },
];

const engineState: EngineRuntimeState = {
  running: true,
  lastPollAt: null,
  lastPollOutcome: null,
  lastSignalAt: null,
  lastSignalStrategy: null,
  lastSignalReason: null,
  currentMarketId: null,
  currentConditionId: null,
  currentMarketQuestion: null,
  currentMarketEndsAt: null,
  currentYesPrice: null,
  currentNoPrice: null,
  openTrades: 0,
  strategyDiagnostics: [],
  managerDecision: {
    chosenStrategyId: null,
    chosenStrategyName: null,
    action: null,
    side: null,
    score: null,
    reason: null,
    decidedAt: null,
  },
  marketDebug: {
    matchedEventTitles: [],
    btcCandidateTitles: [],
  },
};

async function polyFetch(baseUrl: string, path: string, params?: Record<string, string>) {
  const url = new URL(path, baseUrl);
  if (params) {
    Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
  }
  const res = await fetch(url.toString(), {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) {
    throw new Error(`Polymarket API error: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

function parseJsonArray(value?: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseStrategyConfig(strategy: Strategy): Record<string, number> {
  if (!strategy.config) return {};
  try {
    const parsed = JSON.parse(strategy.config);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function eventLooksLikeRollingBtcCandle(event: PolyEvent) {
  const title = event.title;
  const normalized = (title || "").toLowerCase();
  const hasBtc = normalized.includes("bitcoin") || normalized.includes("btc");
  const hasUpDown = normalized.includes("up") && normalized.includes("down");
  const hasMinute = normalized.includes("minute") || normalized.includes("min");
  const hasFive = normalized.includes("5 minute") || normalized.includes("5-minute") || normalized.includes("5 min");
  const hasExplicitTimeRange = /\b\d{1,2}:\d{2}\s?(am|pm)?\s*-\s*\d{1,2}:\d{2}\s?(am|pm)?/i.test(title || "");
  const durationMs = event.startDate && event.endDate
    ? new Date(event.endDate).getTime() - new Date(event.startDate).getTime()
    : null;
  const looksLikeShortRollingWindow = durationMs != null && durationMs > 0 && durationMs <= 6 * 60 * 1000;
  return (
    hasBtc &&
    hasUpDown &&
    (
      (hasMinute && hasFive) ||
      hasExplicitTimeRange ||
      looksLikeShortRollingWindow
    )
  );
}

function eventLooksBtcRelated(title?: string) {
  const normalized = (title || "").toLowerCase();
  return (
    (normalized.includes("bitcoin") || normalized.includes("btc")) &&
    (normalized.includes("minute") || normalized.includes("min") || normalized.includes("up") || normalized.includes("down"))
  );
}

function flattenEvent(event: PolyEvent): PolyMarket[] {
  const markets = Array.isArray(event.markets) ? event.markets : [];
  if (markets.length === 0) {
    return [{
      id: event.id,
      question: event.title,
      conditionId: "",
      outcomePrices: null,
      outcomes: null,
      clobTokenIds: null,
      volumeNum: parseFloat(event.volume || "0"),
      startDate: event.startDate,
      endDate: event.endDate,
      image: event.image,
      _eventTitle: event.title,
      _eventImage: event.image,
    }];
  }
  return markets.map((market) => ({
    ...market,
    startDate: market.startDate || event.startDate,
    _eventTitle: event.title,
    _eventImage: event.image,
  }));
}

function pickCurrentOrNextMarket(markets: PolyMarket[]) {
  const now = Date.now();
  const futureMarkets = markets.filter((market) => market.endDate && new Date(market.endDate).getTime() > now);
  const currentlyLive = futureMarkets
    .filter((market) => {
      if (!market.startDate || !market.endDate) return false;
      const startMs = new Date(market.startDate).getTime();
      const endMs = new Date(market.endDate).getTime();
      return startMs <= now && now < endMs;
    })
    .sort((a, b) => new Date(a.endDate || 0).getTime() - new Date(b.endDate || 0).getTime());

  if (currentlyLive.length > 0) {
    return currentlyLive[0];
  }

  const upcoming = futureMarkets
    .sort((a, b) => {
      const aStart = new Date(a.startDate || a.endDate || 0).getTime();
      const bStart = new Date(b.startDate || b.endDate || 0).getTime();
      return aStart - bStart;
    });

  return upcoming[0] || null;
}

async function fetchCurrentBtcCandleMarket() {
  const events = await polyFetch(GAMMA_API, "/events", {
    limit: "50",
    offset: "0",
    active: "true",
    closed: "false",
    order: "startDate",
    ascending: "false",
  }) as PolyEvent[];

  const allEvents = Array.isArray(events) ? events : [];
  engineState.marketDebug.btcCandidateTitles = allEvents
    .filter((event) => eventLooksBtcRelated(event.title))
    .map((event) => event.title || "")
    .slice(0, 8);

  const matchedEvents = allEvents.filter((event) => eventLooksLikeRollingBtcCandle(event));
  engineState.marketDebug.matchedEventTitles = matchedEvents
    .map((event) => event.title || "")
    .slice(0, 8);

  const candidateMarkets = matchedEvents
    .flatMap(flattenEvent);

  const market = pickCurrentOrNextMarket(candidateMarkets);
  if (!market) {
    return null;
  }

  return market;
}

async function fetchMarketById(marketId: string) {
  return polyFetch(GAMMA_API, `/markets/${marketId}`) as Promise<PolyMarket>;
}

async function fetchMidpoint(tokenId: string | null) {
  if (!tokenId) return null;
  try {
    const data = await polyFetch(CLOB_API, "/midpoint", { token_id: tokenId }) as { mid?: string };
    return data.mid != null ? parseFloat(data.mid) : null;
  } catch {
    return null;
  }
}

async function fetchOrderbook(tokenId: string | null) {
  if (!tokenId) return null;
  try {
    return await polyFetch(CLOB_API, "/book", { token_id: tokenId });
  } catch {
    return null;
  }
}

function getTokenIds(market: PolyMarket) {
  const ids = parseJsonArray(market.clobTokenIds);
  return {
    yesTokenId: ids[0] || null,
    noTokenId: ids[1] || null,
  };
}

function getOutcomePrices(market: PolyMarket) {
  const raw = parseJsonArray(market.outcomePrices);
  return raw.map((value) => parseFloat(value)).filter((value) => Number.isFinite(value));
}

function getOutcomeNames(market: PolyMarket) {
  const names = parseJsonArray(market.outcomes);
  return names.length === 2 ? names : ["Yes", "No"];
}

function clampProbability(value: number | null, fallback = 0.5) {
  if (value == null || !Number.isFinite(value)) return fallback;
  return Math.min(0.99, Math.max(0.01, value));
}

function sumBookSize(levels: any[] | undefined) {
  if (!Array.isArray(levels)) return 0;
  return levels.reduce((sum, level) => {
    const size = parseFloat(level?.size ?? level?.quantity ?? "0");
    return sum + (Number.isFinite(size) ? size : 0);
  }, 0);
}

async function getPriceSnapshot(market: PolyMarket): Promise<PriceSnapshot> {
  const { yesTokenId, noTokenId } = getTokenIds(market);
  const [yesMid, noMid, yesBook, noBook] = await Promise.all([
    fetchMidpoint(yesTokenId),
    fetchMidpoint(noTokenId),
    fetchOrderbook(yesTokenId),
    fetchOrderbook(noTokenId),
  ]);

  const prices = getOutcomePrices(market);
  return {
    yesTokenId,
    noTokenId,
    yesMid: yesMid ?? (prices[0] ?? null),
    noMid: noMid ?? (prices[1] ?? (prices[0] != null ? 1 - prices[0] : null)),
    yesBook,
    noBook,
  };
}

async function fetchRecentBtcCandles(limit = 15) {
  const response = await fetch(
    `https://min-api.cryptocompare.com/data/v2/histominute?fsym=BTC&tsym=USD&limit=${limit}`,
    { signal: AbortSignal.timeout(6000) },
  );
  if (!response.ok) throw new Error("Failed to fetch BTC spot candles");
  const data = await response.json();
  const rows = data?.Data?.Data;
  return Array.isArray(rows) ? rows : [];
}

async function fetchSpotPrice() {
  const response = await fetch(
    "https://min-api.cryptocompare.com/data/price?fsym=BTC&tsyms=USD",
    { signal: AbortSignal.timeout(4000) },
  );
  if (!response.ok) throw new Error("Failed to fetch BTC spot price");
  const data = await response.json();
  return typeof data?.USD === "number" ? data.USD : 0;
}

function calculateTakerFee(stake: number, price: number, feeRate: number) {
  const safePrice = clampProbability(price);
  return stake * feeRate * (1 - safePrice);
}

function getResolutionPriceForOutcome(market: PolyMarket, outcome: "YES" | "NO") {
  const outcomePrices = getOutcomePrices(market);
  if (outcomePrices.length < 2) return null;
  const resolutionPrice = outcome === "YES" ? outcomePrices[0] : outcomePrices[1];
  if (!Number.isFinite(resolutionPrice)) return null;
  if (resolutionPrice < 0 || resolutionPrice > 1) return null;
  return resolutionPrice;
}

function isResolvedMarket(market: PolyMarket) {
  const prices = getOutcomePrices(market);
  if (prices.length < 2) return false;
  const [yesPrice, noPrice] = prices;
  const sumLooksResolved = Math.abs((yesPrice + noPrice) - 1) < 0.01;
  const discrete =
    [0, 0.5, 1].includes(Number(yesPrice.toFixed(3))) &&
    [0, 0.5, 1].includes(Number(noPrice.toFixed(3)));
  return sumLooksResolved && discrete && (market.closed === true || market.active === false);
}

function getTodayKey() {
  return new Date().toISOString().slice(0, 10);
}

function ensurePaperDefaults() {
  if (!storage.getSetting("paper_balance")) storage.setSetting("paper_balance", "1000");
  if (!storage.getSetting("day_start_balance")) storage.setSetting("day_start_balance", "1000");
  if (!storage.getSetting("taker_fee_rate")) storage.setSetting("taker_fee_rate", "0.072");
  if (!storage.getSetting("drawdown_limit")) storage.setSetting("drawdown_limit", "0.10");
  if (!storage.getSetting("circuit_breaker")) storage.setSetting("circuit_breaker", "ok");
  if (!storage.getSetting("multi_source_verify")) storage.setSetting("multi_source_verify", "true");
  if (!storage.getSetting("polling_interval")) storage.setSetting("polling_interval", "15");
  if (!storage.getSetting("max_daily_trades")) storage.setSetting("max_daily_trades", "24");
  if (!storage.getSetting("max_order_size")) storage.setSetting("max_order_size", "25");
  storage.setSetting("mode", "paper");
}

function countTradesToday() {
  const todayKey = getTodayKey();
  return storage.getTradeLogs(5000).filter((trade) => trade.timestamp.startsWith(todayKey)).length;
}

function getOpenExposure() {
  return storage.getOpenTrades().reduce((sum, trade) => sum + trade.size, 0);
}

function maybeRollDayStartBalance() {
  const todayKey = getTodayKey();
  const lastReset = storage.getSetting("day_balance_reset") || "";
  if (lastReset === todayKey) return;
  const balance = parseFloat(storage.getSetting("paper_balance") || "1000");
  storage.setSetting("day_start_balance", String(balance));
  storage.setSetting("day_balance_reset", todayKey);
  storage.setSetting("circuit_breaker", "ok");
  storage.setSetting("circuit_breaker_at", "");
}

async function settleResolvedTrades() {
  const feeRate = parseFloat(storage.getSetting("taker_fee_rate") || "0.072");
  const openTrades = storage.getOpenTrades();

  for (const trade of openTrades) {
    if (!trade.marketId) continue;

    try {
      const market = await fetchMarketById(trade.marketId);
      if (!isResolvedMarket(market)) continue;

      const resolutionPrice = getResolutionPriceForOutcome(
        market,
        trade.outcome === "YES" ? "YES" : "NO",
      );
      if (resolutionPrice == null) continue;

      const entryPrice = clampProbability(trade.price);
      const shares = trade.size / entryPrice;
      const payout = shares * resolutionPrice;
      const grossPnl = payout - trade.size;
      const entryFee = trade.feePaid ?? calculateTakerFee(trade.size, entryPrice, feeRate);
      const netPnl = grossPnl - entryFee;
      const pnlPercent = trade.size > 0 ? (netPnl / trade.size) * 100 : 0;
      const won = netPnl > 0;

      storage.updateTradeLog(trade.id, {
        status: "closed",
        exitPrice: resolutionPrice,
        pnl: grossPnl,
        pnlPercent,
        feePaid: entryFee,
        netPnl,
        errorMessage: null,
        closedAt: new Date().toISOString(),
      });

      storage.updateStrategyPnl(trade.strategyId ?? 0, netPnl, won);
      const currentBalance = parseFloat(storage.getSetting("paper_balance") || "1000");
      const newBalance = currentBalance + netPnl;
      storage.setSetting("paper_balance", String(newBalance));

      const startOfDayBalance = parseFloat(storage.getSetting("day_start_balance") || String(newBalance));
      const drawdownLimit = parseFloat(storage.getSetting("drawdown_limit") || "0.10");
      const drawdownPct = startOfDayBalance > 0 ? (startOfDayBalance - newBalance) / startOfDayBalance : 0;
      if (drawdownPct >= drawdownLimit) {
        storage.setSetting("circuit_breaker", "triggered");
        storage.setSetting("circuit_breaker_at", new Date().toISOString());
      }
    } catch {
      continue;
    }
  }
}

function chooseEntryFromSignal(signalSide: "YES" | "NO", snapshot: PriceSnapshot) {
  return signalSide === "YES"
    ? { tokenId: snapshot.yesTokenId, price: clampProbability(snapshot.yesMid), outcome: "YES" as const, side: "BUY" as const }
    : { tokenId: snapshot.noTokenId, price: clampProbability(snapshot.noMid), outcome: "NO" as const, side: "BUY" as const };
}

async function evaluateSignal(
  strategy: Strategy,
  market: PolyMarket,
  snapshot: PriceSnapshot,
  candles: any[],
) {
  const config = parseStrategyConfig(strategy);
  const yesPrice = clampProbability(snapshot.yesMid);
  const noPrice = clampProbability(snapshot.noMid, 1 - yesPrice);
  const timeLeftMs = market.endDate ? new Date(market.endDate).getTime() - Date.now() : 0;
  const secondsLeft = Math.floor(timeLeftMs / 1000);
  const minSecondsLeft = Number(config.minSecondsLeft ?? 45);
  const multiSourceVerify = storage.getSetting("multi_source_verify") !== "false";

  if (secondsLeft < minSecondsLeft) {
    return null;
  }

  if (strategy.name === "Last-Second Momentum Snipe") {
    const window = candles.slice(-10);
    const greenBars = window.filter((c: any) => c.close > c.open).length;
    const momentum = window.length > 0 ? greenBars / window.length : 0;
    const lastThreeGreen = window.slice(-3).every((c: any) => c.close > c.open);
    const triggerPrice = Number(config.triggerPrice ?? strategy.triggerPrice ?? 0.48);
    const threshold = Number(config.momentumThreshold ?? 0.65);
    if (yesPrice <= triggerPrice && momentum >= threshold && lastThreeGreen) {
      const edge = Math.max(0, triggerPrice - yesPrice);
      return {
        side: "YES" as const,
        score: momentum * 0.7 + edge * 8,
        reason: `Momentum ${momentum.toFixed(2)} with YES at ${(yesPrice * 100).toFixed(1)}%`,
      };
    }
    return null;
  }

  if (strategy.name === "Orderbook Arbitrage & Imbalance") {
    const yesBidDepth = sumBookSize(snapshot.yesBook?.bids);
    const noBidDepth = sumBookSize(snapshot.noBook?.bids);
    const totalDepth = yesBidDepth + noBidDepth;
    if (totalDepth <= 0) return null;
    const imbalance = (yesBidDepth - noBidDepth) / totalDepth;
    const threshold = Number(config.imbalanceThreshold ?? 0.18);
    const maxEntryPrice = Number(config.maxEntryPrice ?? 0.56);
    if (imbalance >= threshold && yesPrice <= maxEntryPrice) {
      return {
        side: "YES" as const,
        score: Math.abs(imbalance) * 1.6 + Math.max(0, maxEntryPrice - yesPrice) * 4,
        reason: `YES bid imbalance ${imbalance.toFixed(2)}`,
      };
    }
    if (imbalance <= -threshold && noPrice <= maxEntryPrice) {
      return {
        side: "NO" as const,
        score: Math.abs(imbalance) * 1.6 + Math.max(0, maxEntryPrice - noPrice) * 4,
        reason: `NO bid imbalance ${imbalance.toFixed(2)}`,
      };
    }
    return null;
  }

  if (strategy.name === "Spot Correlation Reversion Scalp") {
    const windowBars = Math.max(4, Number(config.windowBars ?? 8));
    const window = candles.slice(-windowBars);
    if (window.length < 4) return null;
    const windowLow = Math.min(...window.map((c: any) => c.low ?? c.close));
    const lastClose = window[window.length - 1].close;
    const rebound = windowLow > 0 ? (lastClose - windowLow) / windowLow : 0;
    const redBars = window.filter((c: any) => c.close < c.open).length;
    const triggerPrice = Number(config.triggerPrice ?? strategy.triggerPrice ?? 0.46);
    const reboundThreshold = Number(config.reboundThreshold ?? 0.0025);
    const downtrend = redBars / window.length >= 0.5;
    if (yesPrice <= triggerPrice && rebound >= reboundThreshold && (!multiSourceVerify || downtrend)) {
      return {
        side: "YES" as const,
        score: rebound * 120 + Math.max(0, triggerPrice - yesPrice) * 6,
        reason: `Rebound ${rebound.toFixed(4)} with YES at ${(yesPrice * 100).toFixed(1)}%`,
      };
    }
    return null;
  }

  if (strategy.name === "Oracle Lead Arbitrage") {
    const window = candles.slice(-4);
    if (window.length < 3) return null;
    const firstClose = window[0].close;
    const lastClose = window[window.length - 1].close;
    const delta = firstClose > 0 ? (lastClose - firstClose) / firstClose : 0;
    const threshold = Number(config.spotMoveThreshold ?? 0.002);
    const maxEntryPrice = Number(config.maxEntryPrice ?? 0.6);
    if (delta >= threshold && yesPrice <= maxEntryPrice) {
      return {
        side: "YES" as const,
        score: delta * 140 + Math.max(0, maxEntryPrice - yesPrice) * 4,
        reason: `Spot delta +${(delta * 100).toFixed(2)}% with YES lagging`,
      };
    }
    if (delta <= -threshold && noPrice <= maxEntryPrice) {
      return {
        side: "NO" as const,
        score: Math.abs(delta) * 140 + Math.max(0, maxEntryPrice - noPrice) * 4,
        reason: `Spot delta ${(delta * 100).toFixed(2)}% with NO lagging`,
      };
    }
    return null;
  }

  return null;
}

async function runEngineOnce() {
  ensurePaperDefaults();
  maybeRollDayStartBalance();
  await settleResolvedTrades();
  engineState.lastPollAt = new Date().toISOString();
  engineState.openTrades = storage.getOpenTrades().length;

  if (storage.getSetting("circuit_breaker") === "triggered") {
    engineState.lastPollOutcome = "paused_by_circuit_breaker";
    return;
  }

  const strategies = storage.getStrategies().filter((strategy) => strategy.isActive);
  const checkedAt = new Date().toISOString();
  engineState.strategyDiagnostics = strategies.map((strategy) => ({
    strategyId: strategy.id,
    strategyName: strategy.name,
    outcome: "pending_scan",
    detail: "Waiting for engine evaluation",
    score: null,
    checkedAt,
  }));
  engineState.managerDecision = {
    chosenStrategyId: null,
    chosenStrategyName: null,
    action: null,
    side: null,
    score: null,
    reason: null,
    decidedAt: checkedAt,
  };
  if (strategies.length === 0) {
    engineState.lastPollOutcome = "idle_no_active_strategies";
    return;
  }

  const market = await fetchCurrentBtcCandleMarket();
  if (!market || !market.conditionId) {
    engineState.currentMarketId = null;
    engineState.currentConditionId = null;
    engineState.currentMarketQuestion = null;
    engineState.currentMarketEndsAt = null;
    engineState.currentYesPrice = null;
    engineState.currentNoPrice = null;
    engineState.lastPollOutcome = "waiting_for_current_btc_market";
    return;
  }

  const snapshot = await getPriceSnapshot(market);
  const candles = await fetchRecentBtcCandles(15).catch(() => []);
  engineState.currentMarketId = market.id;
  engineState.currentConditionId = market.conditionId;
  engineState.currentMarketQuestion = market._eventTitle || market.question || "BTC 5-minute market";
  engineState.currentMarketEndsAt = market.endDate || null;
  engineState.currentYesPrice = snapshot.yesMid;
  engineState.currentNoPrice = snapshot.noMid;
  const maxDailyTrades = parseInt(storage.getSetting("max_daily_trades") || "24", 10);
  const maxOrderSize = parseFloat(storage.getSetting("max_order_size") || "25");
  let tradesToday = countTradesToday();
  let openExposure = getOpenExposure();
  let openedTrade = false;
  let lastSkipReason = "scanned_no_signal";
  const recommendations: Array<{
    strategy: Strategy;
    diagnostic: NonNullable<EngineRuntimeState["strategyDiagnostics"]>[number] | undefined;
    signal: { side: "YES" | "NO"; score: number; reason: string };
    orderSize: number;
  }> = [];

  for (const strategy of strategies) {
    const diagnostic = engineState.strategyDiagnostics.find((item) => item.strategyId === strategy.id);
    try {
      storage.updateStrategy(strategy.id, {
        currentConditionId: market.conditionId,
        marketQuestion: market._eventTitle || market.question || strategy.marketQuestion,
      });

      if (storage.getOpenTradeByStrategyAndCondition(strategy.id, market.conditionId)) {
        lastSkipReason = `${strategy.name}: already_open_for_current_market`;
        if (diagnostic) {
          diagnostic.outcome = "already_open";
          diagnostic.detail = "Trade already open for this BTC candle";
          diagnostic.score = null;
        }
        continue;
      }

      if (strategy.lastTriggered) {
        const cooldownMs = Math.max(1, strategy.cooldownMinutes ?? 1) * 60 * 1000;
        if (Date.now() - new Date(strategy.lastTriggered).getTime() < cooldownMs) {
          lastSkipReason = `${strategy.name}: cooldown_active`;
        if (diagnostic) {
          diagnostic.outcome = "cooldown";
          diagnostic.detail = "Waiting for strategy cooldown to expire";
          diagnostic.score = null;
        }
        continue;
      }
      }

      const requestedSize = Number(parseStrategyConfig(strategy).orderSize ?? strategy.orderSize ?? 10);
      const orderSize = Math.min(requestedSize, maxOrderSize);
      const balance = parseFloat(storage.getSetting("paper_balance") || "1000");
      if (tradesToday >= maxDailyTrades) {
        lastSkipReason = "max_daily_trades_reached";
        if (diagnostic) {
          diagnostic.outcome = "limit_reached";
          diagnostic.detail = "Max daily trades reached";
          diagnostic.score = null;
        }
        break;
      }
      if (orderSize <= 0) {
        lastSkipReason = `${strategy.name}: invalid_order_size`;
        if (diagnostic) {
          diagnostic.outcome = "invalid_size";
          diagnostic.detail = "Order size must be greater than zero";
          diagnostic.score = null;
        }
        continue;
      }
      if (openExposure + orderSize > balance) {
        lastSkipReason = `${strategy.name}: insufficient_paper_balance`;
        if (diagnostic) {
          diagnostic.outcome = "balance_blocked";
          diagnostic.detail = "Paper balance would be exceeded";
          diagnostic.score = null;
        }
        continue;
      }

      const signal = await evaluateSignal(strategy, market, snapshot, candles);
      if (!signal) {
        lastSkipReason = `${strategy.name}: no_signal`;
        if (diagnostic) {
          diagnostic.outcome = "no_signal";
          diagnostic.detail = "Current BTC candle does not satisfy this strategy";
          diagnostic.score = null;
        }
        continue;
      }

      if (diagnostic) {
        diagnostic.outcome = "recommended";
        diagnostic.detail = signal.reason;
        diagnostic.score = Number(signal.score.toFixed(3));
      }
      recommendations.push({ strategy, diagnostic, signal, orderSize });
    } catch {
      if (diagnostic) {
        diagnostic.outcome = "error";
        diagnostic.detail = "Strategy evaluation failed";
        diagnostic.score = null;
      }
      continue;
    }
  }

  if (recommendations.length === 0) {
    engineState.managerDecision = {
      chosenStrategyId: null,
      chosenStrategyName: null,
      action: "stand_down",
      side: null,
      score: null,
      reason: "No specialist agent produced a valid recommendation",
      decidedAt: new Date().toISOString(),
    };
    engineState.lastPollOutcome = lastSkipReason;
    return;
  }

  recommendations.sort((a, b) => b.signal.score - a.signal.score);
  const winner = recommendations[0];
  const managerScoreThreshold = 0.62;
  engineState.managerDecision = {
    chosenStrategyId: winner.strategy.id,
    chosenStrategyName: winner.strategy.name,
    action: winner.signal.score >= managerScoreThreshold ? "enter_trade" : "stand_down",
    side: winner.signal.side,
    score: Number(winner.signal.score.toFixed(3)),
    reason: winner.signal.reason,
    decidedAt: new Date().toISOString(),
  };

  for (const recommendation of recommendations) {
    if (!recommendation.diagnostic) continue;
    if (recommendation.strategy.id === winner.strategy.id) {
      recommendation.diagnostic.outcome = winner.signal.score >= managerScoreThreshold ? "manager_selected" : "manager_passed";
      recommendation.diagnostic.detail = winner.signal.score >= managerScoreThreshold
        ? `Manager selected this play: ${winner.signal.reason}`
        : `Best idea, but manager passed: score ${winner.signal.score.toFixed(2)} below threshold`;
    } else {
      recommendation.diagnostic.outcome = "manager_rejected";
      recommendation.diagnostic.detail = `Manager preferred ${winner.strategy.name} (${winner.signal.score.toFixed(2)}) over this setup`;
    }
  }

  if (winner.signal.score < managerScoreThreshold) {
    engineState.lastPollOutcome = "manager_stood_down";
    return;
  }

  const diagnostic = winner.diagnostic;
  try {
      const entry = chooseEntryFromSignal(winner.signal.side, snapshot);
      if (!entry.tokenId || !Number.isFinite(entry.price) || entry.price <= 0) {
        lastSkipReason = `${winner.strategy.name}: invalid_entry_snapshot`;
        if (diagnostic) {
          diagnostic.outcome = "bad_snapshot";
          diagnostic.detail = "Missing token or midpoint for manager-selected entry";
          diagnostic.score = Number(winner.signal.score.toFixed(3));
        }
        engineState.lastPollOutcome = lastSkipReason;
        return;
      }

      const feeRate = parseFloat(storage.getSetting("taker_fee_rate") || "0.072");
      const entryFee = calculateTakerFee(winner.orderSize, entry.price, feeRate);
      storage.createTradeLog({
        strategyId: winner.strategy.id,
        strategyName: winner.strategy.name,
        marketId: market.id,
        conditionId: market.conditionId,
        tokenId: entry.tokenId,
        side: entry.side,
        outcome: entry.outcome,
        price: entry.price,
        size: winner.orderSize,
        status: "open",
        timestamp: new Date().toISOString(),
        marketQuestion: market._eventTitle || market.question || winner.strategy.marketQuestion,
        feePaid: entryFee,
        errorMessage: `Manager chose ${winner.strategy.name}: ${winner.signal.reason}`,
      });

      storage.markStrategyTriggered(winner.strategy.id);
      tradesToday += 1;
      openExposure += winner.orderSize;
      openedTrade = true;
      engineState.lastSignalAt = new Date().toISOString();
      engineState.lastSignalStrategy = winner.strategy.name;
      engineState.lastSignalReason = `Manager selected ${winner.strategy.name}: ${winner.signal.reason}`;
      engineState.openTrades = storage.getOpenTrades().length;
      if (diagnostic) {
        diagnostic.outcome = "entered";
        diagnostic.detail = `Manager entered trade: ${winner.signal.reason}`;
        diagnostic.score = Number(winner.signal.score.toFixed(3));
      }
    } catch {
      if (diagnostic) {
        diagnostic.outcome = "error";
        diagnostic.detail = "Manager-selected trade failed during entry";
        diagnostic.score = Number(winner.signal.score.toFixed(3));
      }
      engineState.lastPollOutcome = "manager_entry_failed";
      return;
    }

  engineState.lastPollOutcome = openedTrade ? "opened_paper_trade" : lastSkipReason;
}

export async function registerRoutes(httpServer: Server, app: Express): Promise<Server> {
  storage.upsertStrategies(FIXED_STRATEGIES as any);
  ensurePaperDefaults();

  app.get("/api/markets", async (req, res) => {
    try {
      const search = req.query.search as string | undefined;
      const showClosed = req.query.closed === "true";
      const tag = req.query.tag as string | undefined;

      const baseParams: Record<string, string> = { limit: "100", offset: "0" };
      if (tag) baseParams.tag = tag;

      if (showClosed) {
        const closedEvents = await polyFetch(GAMMA_API, "/events", {
          ...baseParams,
          active: "false",
          closed: "true",
          order: "endDate",
          ascending: "false",
        }) as PolyEvent[];
        const allMarkets = (Array.isArray(closedEvents) ? closedEvents : []).flatMap(flattenEvent);
        const filtered = search
          ? allMarkets.filter((market) =>
              market.question?.toLowerCase().includes(search.toLowerCase()) ||
              market._eventTitle?.toLowerCase().includes(search.toLowerCase()))
          : allMarkets;
        res.json(filtered);
        return;
      }

      const nowIso = new Date().toISOString();
      const [newestEvents, topEvents] = await Promise.all([
        polyFetch(GAMMA_API, "/events", {
          ...baseParams,
          active: "true",
          closed: "false",
          end_date_min: nowIso,
          order: "startDate",
          ascending: "false",
        }) as Promise<PolyEvent[]>,
        polyFetch(GAMMA_API, "/events", {
          ...baseParams,
          active: "true",
          closed: "false",
          end_date_min: nowIso,
          order: "volume",
          ascending: "false",
        }) as Promise<PolyEvent[]>,
      ]);

      const seen = new Set<string>();
      const merged = [...(newestEvents || []), ...(topEvents || [])].filter((event) => {
        if (seen.has(event.id)) return false;
        seen.add(event.id);
        return true;
      });

      const markets = merged
        .flatMap(flattenEvent)
        .filter((market) => !market.endDate || new Date(market.endDate).getTime() > Date.now());

      const filtered = search
        ? markets.filter((market) =>
            market.question?.toLowerCase().includes(search.toLowerCase()) ||
            market._eventTitle?.toLowerCase().includes(search.toLowerCase()))
        : markets;

      res.json(filtered);
    } catch (e: any) {
      res.status(502).json({ error: e.message });
    }
  });

  app.get("/api/markets/btc-candle/current", async (_req, res) => {
    try {
      const market = await fetchCurrentBtcCandleMarket();
      if (!market) {
        res.status(404).json({ error: "No active BTC 5-minute candle market found" });
        return;
      }
      res.json({ market });
    } catch (e: any) {
      res.status(502).json({ error: e.message });
    }
  });

  app.get("/api/markets/:id", async (req, res) => {
    try {
      const data = await polyFetch(GAMMA_API, `/markets/${req.params.id}`);
      res.json(data);
    } catch (e: any) {
      res.status(502).json({ error: e.message });
    }
  });

  app.get("/api/events", async (req, res) => {
    try {
      const limit = (req.query.limit as string) || "20";
      const offset = (req.query.offset as string) || "0";
      const params: Record<string, string> = { limit, offset, active: "true", closed: "false" };
      if (req.query.tag) params.tag = req.query.tag as string;
      const data = await polyFetch(GAMMA_API, "/events", params);
      res.json(data);
    } catch (e: any) {
      res.status(502).json({ error: e.message });
    }
  });

  app.get("/api/tags", async (_req, res) => {
    try {
      const data = await polyFetch(GAMMA_API, "/tags");
      res.json(data);
    } catch (e: any) {
      res.status(502).json({ error: e.message });
    }
  });

  app.get("/api/orderbook/:tokenId", async (req, res) => {
    try {
      const data = await polyFetch(CLOB_API, "/book", { token_id: req.params.tokenId });
      res.json(data);
    } catch (e: any) {
      res.status(502).json({ error: e.message });
    }
  });

  app.get("/api/price/:tokenId", async (req, res) => {
    try {
      const data = await polyFetch(CLOB_API, "/price", {
        token_id: req.params.tokenId,
        side: (req.query.side as string) || "BUY",
      });
      res.json(data);
    } catch (e: any) {
      res.status(502).json({ error: e.message });
    }
  });

  app.get("/api/midpoint/:tokenId", async (req, res) => {
    try {
      const data = await polyFetch(CLOB_API, "/midpoint", { token_id: req.params.tokenId });
      res.json(data);
    } catch (e: any) {
      res.status(502).json({ error: e.message });
    }
  });

  app.get("/api/spread/:tokenId", async (req, res) => {
    try {
      const data = await polyFetch(CLOB_API, "/spread", { token_id: req.params.tokenId });
      res.json(data);
    } catch (e: any) {
      res.status(502).json({ error: e.message });
    }
  });

  app.get("/api/strategies", async (_req, res) => {
    res.json(storage.getStrategies());
  });

  app.get("/api/strategies/:id", async (req, res) => {
    const strategy = storage.getStrategy(parseInt(req.params.id, 10));
    if (!strategy) {
      res.status(404).json({ error: "Strategy not found" });
      return;
    }
    res.json(strategy);
  });

  app.post("/api/strategies", async (req, res) => {
    try {
      const parsed = insertStrategySchema.parse(req.body);
      const strategy = storage.createStrategy(parsed);
      res.json(strategy);
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  app.patch("/api/strategies/:id", async (req, res) => {
    const strategy = storage.updateStrategy(parseInt(req.params.id, 10), req.body);
    if (!strategy) {
      res.status(404).json({ error: "Strategy not found" });
      return;
    }
    res.json(strategy);
  });

  app.delete("/api/strategies/:id", async (req, res) => {
    storage.deleteStrategy(parseInt(req.params.id, 10));
    res.json({ success: true });
  });

  app.post("/api/strategies/:id/toggle", async (req, res) => {
    const { isActive } = req.body;
    const strategy = storage.toggleStrategy(parseInt(req.params.id, 10), Boolean(isActive));
    if (!strategy) {
      res.status(404).json({ error: "Strategy not found" });
      return;
    }
    res.json(strategy);
  });

  app.post("/api/strategies/:id/simulate", async (req, res) => {
    const strategy = storage.getStrategy(parseInt(req.params.id, 10));
    if (!strategy) {
      res.status(404).json({ error: "Strategy not found" });
      return;
    }

    try {
      const market = await fetchCurrentBtcCandleMarket();
      if (!market || !market.conditionId) {
        res.status(404).json({ error: "No active BTC candle market found" });
        return;
      }

      const snapshot = await getPriceSnapshot(market);
      const candles = await fetchRecentBtcCandles(15).catch(() => []);
      const signal = await evaluateSignal(strategy, market, snapshot, candles);
      res.json({
        triggered: Boolean(signal),
        marketId: market.id,
        conditionId: market.conditionId,
        yesPrice: snapshot.yesMid,
        noPrice: snapshot.noMid,
        reason: signal?.reason ?? null,
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/trades", async (req, res) => {
    const limit = parseInt((req.query.limit as string) || "100", 10);
    res.json(storage.getTradeLogs(limit));
  });

  app.get("/api/trades/strategy/:id", async (req, res) => {
    res.json(storage.getTradeLogsByStrategy(parseInt(req.params.id, 10)));
  });

  app.get("/api/trades/last-per-strategy", async (_req, res) => {
    const result: Record<number, TradeLog> = {};
    for (const strategy of storage.getStrategies()) {
      const latest = storage.getTradeLogsByStrategy(strategy.id)[0];
      if (latest) result[strategy.id] = latest;
    }
    res.json(result);
  });

  app.post("/api/trades/:id/close", async (req, res) => {
    const trade = storage.getTradeLog(parseInt(req.params.id, 10));
    if (!trade) {
      res.status(404).json({ error: "Trade not found" });
      return;
    }

    const exitPrice = parseFloat(req.body?.exitPrice);
    if (!Number.isFinite(exitPrice) || exitPrice <= 0 || exitPrice > 1) {
      res.status(400).json({ error: "exitPrice must be between 0 and 1" });
      return;
    }

    const feeRate = parseFloat(storage.getSetting("taker_fee_rate") || "0.072");
    const entryPrice = clampProbability(trade.price);
    const shares = trade.size / entryPrice;
    const proceeds = shares * exitPrice;
    const grossPnl = proceeds - trade.size;
    const totalFees = (trade.feePaid ?? calculateTakerFee(trade.size, entryPrice, feeRate))
      + calculateTakerFee(proceeds, exitPrice, feeRate);
    const netPnl = grossPnl - totalFees;
    const pnlPercent = trade.size > 0 ? (netPnl / trade.size) * 100 : 0;

    storage.updateTradeLog(trade.id, {
      status: "closed",
      exitPrice,
      pnl: grossPnl,
      netPnl,
      feePaid: totalFees,
      pnlPercent,
      closedAt: new Date().toISOString(),
    });

    if (trade.strategyId) {
      storage.updateStrategyPnl(trade.strategyId, netPnl, netPnl > 0);
    }
    const balance = parseFloat(storage.getSetting("paper_balance") || "1000") + netPnl;
    storage.setSetting("paper_balance", String(balance));
    res.json({ grossPnl, netPnl, feePaid: totalFees, pnlPercent });
  });

  app.get("/api/watchlist", async (_req, res) => {
    res.json(storage.getWatchlist());
  });

  app.post("/api/watchlist", async (req, res) => {
    try {
      const parsed = insertWatchlistSchema.parse(req.body);
      const item = storage.addToWatchlist(parsed);
      res.json(item);
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  app.delete("/api/watchlist/:id", async (req, res) => {
    storage.removeFromWatchlist(parseInt(req.params.id, 10));
    res.json({ success: true });
  });

  app.get("/api/settings", async (_req, res) => {
    ensurePaperDefaults();
    res.json(storage.getAllSettings());
  });

  app.post("/api/settings", async (req, res) => {
    const { key, value } = req.body;
    if (!key || value === undefined) {
      res.status(400).json({ error: "key and value required" });
      return;
    }

    if (key === "mode") {
      storage.setSetting("mode", "paper");
      res.json({ success: true, value: "paper" });
      return;
    }

    storage.setSetting(key, String(value));
    res.json({ success: true });
  });

  app.get("/api/paper-balance", (_req, res) => {
    const balance = parseFloat(storage.getSetting("paper_balance") || "1000");
    res.json({ balance });
  });

  app.post("/api/paper-balance", (req, res) => {
    const { balance } = req.body;
    if (typeof balance !== "number") {
      res.status(400).json({ error: "balance must be a number" });
      return;
    }
    storage.setSetting("paper_balance", String(balance));
    storage.setSetting("day_start_balance", String(balance));
    res.json({ balance });
  });

  app.get("/api/pnl", (_req, res) => {
    const strategies = storage.getStrategies();
    const totalPnl = strategies.reduce((sum, strategy) => sum + (strategy.totalPnl ?? 0), 0);
    const totalWins = strategies.reduce((sum, strategy) => sum + (strategy.winCount ?? 0), 0);
    const totalLosses = strategies.reduce((sum, strategy) => sum + (strategy.lossCount ?? 0), 0);
    const paperBalance = parseFloat(storage.getSetting("paper_balance") || "1000");
    const perStrategy = strategies.map((strategy) => ({
      id: strategy.id,
      name: strategy.name,
      totalPnl: strategy.totalPnl ?? 0,
      winCount: strategy.winCount ?? 0,
      lossCount: strategy.lossCount ?? 0,
      totalExecutions: strategy.totalExecutions,
      winRate: strategy.winCount + strategy.lossCount > 0
        ? ((strategy.winCount ?? 0) / (strategy.winCount + strategy.lossCount) * 100).toFixed(1)
        : null,
    }));
    res.json({ totalPnl, totalWins, totalLosses, paperBalance, perStrategy });
  });

  app.get("/api/safeguards", async (_req, res) => {
    const balance = parseFloat(storage.getSetting("paper_balance") || "1000");
    const startOfDayBalance = parseFloat(storage.getSetting("day_start_balance") || "1000");
    const drawdownLimit = parseFloat(storage.getSetting("drawdown_limit") || "0.10");
    const circuitBreaker = storage.getSetting("circuit_breaker") || "ok";
    const circuitBreakerAt = storage.getSetting("circuit_breaker_at") || null;
    const drawdownPct = startOfDayBalance > 0
      ? Math.max(0, (startOfDayBalance - balance) / startOfDayBalance)
      : 0;

    let latencyMs: number | null = null;
    try {
      const start = Date.now();
      await fetch("https://gamma-api.polymarket.com/events?limit=1&active=true", {
        signal: AbortSignal.timeout(3000),
      });
      latencyMs = Date.now() - start;
    } catch {
      latencyMs = null;
    }

    let lagScore: number | null = null;
    let polyPrice: number | null = null;
    let chainlinkPrice: number | null = null;
    try {
      const market = await fetchCurrentBtcCandleMarket();
      if (market) {
        const snapshot = await getPriceSnapshot(market);
        polyPrice = snapshot.yesMid;
      }
      chainlinkPrice = await fetchSpotPrice();
      if (polyPrice != null) {
        lagScore = Math.abs(polyPrice - 0.5) * 2;
      }
    } catch {
      lagScore = null;
    }

    res.json({
      drawdownPct: parseFloat((drawdownPct * 100).toFixed(2)),
      drawdownLimit: parseFloat((drawdownLimit * 100).toFixed(0)),
      circuitBreaker,
      circuitBreakerAt,
      latencyMs,
      lagScore,
      polyPrice,
      chainlinkPrice,
      openTrades: storage.getOpenTrades().length,
    });
  });

  app.post("/api/safeguards/reset", (_req, res) => {
    const balance = parseFloat(storage.getSetting("paper_balance") || "1000");
    storage.setSetting("circuit_breaker", "ok");
    storage.setSetting("circuit_breaker_at", "");
    storage.setSetting("day_start_balance", String(balance));
    storage.setSetting("day_balance_reset", getTodayKey());
    res.json({ ok: true });
  });

  app.post("/api/backtest", async (req, res) => {
    try {
      const { strategyName, periodDays = 7, orderSize = 10 } = req.body;
      const feeRate = parseFloat(storage.getSetting("taker_fee_rate") || "0.072");
      const lookbackMinutes = Math.min(Math.max(60, Number(periodDays) * 24 * 60), 2000);

      const response = await fetch(
        `https://min-api.cryptocompare.com/data/v2/histominute?fsym=BTC&tsym=USD&limit=${lookbackMinutes}`,
        { signal: AbortSignal.timeout(12000) },
      );
      if (!response.ok) throw new Error("Failed to fetch historical BTC data");
      const data = await response.json();
      const candles = Array.isArray(data?.Data?.Data) ? data.Data.Data : [];
      if (candles.length < 20) {
        res.status(502).json({ error: "Not enough historical data returned" });
        return;
      }

      let wins = 0;
      let losses = 0;
      let grossPnl = 0;
      let totalFees = 0;
      const edges: number[] = [];

      for (let i = 10; i < candles.length - 5; i += 5) {
        const segment = candles.slice(i - 10, i + 5);
        if (segment.length < 15) continue;

        const recent = segment.slice(0, 10);
        const future = segment.slice(10);
        const start = recent[recent.length - 1].close;
        const end = future[future.length - 1].close;
        const delta = start > 0 ? (end - start) / start : 0;
        const simulatedYesPrice = clampProbability(0.5 - delta * 6);
        const simulatedNoPrice = clampProbability(1 - simulatedYesPrice);

        let side: "YES" | "NO" | null = null;
        if (strategyName === "Last-Second Momentum Snipe") {
          const greenRatio = recent.filter((c: any) => c.close > c.open).length / recent.length;
          if (greenRatio >= 0.6 && simulatedYesPrice <= 0.48) side = "YES";
        } else if (strategyName === "Orderbook Arbitrage & Imbalance") {
          if (Math.abs(delta) >= 0.0015) side = delta >= 0 ? "YES" : "NO";
        } else if (strategyName === "Spot Correlation Reversion Scalp") {
          const low = Math.min(...recent.map((c: any) => c.low ?? c.close));
          const rebound = low > 0 ? (recent[recent.length - 1].close - low) / low : 0;
          if (rebound >= 0.0025 && simulatedYesPrice <= 0.46) side = "YES";
        } else if (strategyName === "Oracle Lead Arbitrage") {
          if (Math.abs(delta) >= 0.002) side = delta >= 0 ? "YES" : "NO";
        }

        if (!side) continue;

        const entryPrice = side === "YES" ? simulatedYesPrice : simulatedNoPrice;
        const entryFee = calculateTakerFee(orderSize, entryPrice, feeRate);
        const shares = orderSize / entryPrice;
        const payout = shares * ((side === "YES" && end >= start) || (side === "NO" && end < start) ? 1 : 0);
        const grossTradePnl = payout - orderSize;
        const netTrade = grossTradePnl - entryFee;

        grossPnl += grossTradePnl;
        totalFees += entryFee;
        edges.push(netTrade);
        if (netTrade > 0) wins += 1;
        else losses += 1;
      }

      const totalTrades = wins + losses;
      const winRate = totalTrades > 0 ? wins / totalTrades : 0;
      const netPnl = grossPnl - totalFees;
      const avgEdge = edges.length > 0 ? edges.reduce((sum, edge) => sum + edge, 0) / edges.length : 0;
      const edgePct = orderSize > 0 ? (avgEdge / orderSize) * 100 : 0;
      const meetsTarget = winRate >= 0.55 && edgePct >= 0.5;

      const run = storage.saveBacktestRun({
        strategyName,
        ranAt: new Date().toISOString(),
        periodDays,
        totalTrades,
        wins,
        losses,
        winRate,
        grossPnl,
        totalFees,
        netPnl,
        edgePct,
        meetsTarget,
      });

      res.json(run);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/backtest", (_req, res) => {
    res.json(storage.getBacktestRuns());
  });

  app.get("/api/bot/status", async (_req, res) => {
    const strategies = storage.getStrategies();
    const recentTrades = storage.getTradeLogs(10);
    res.json({
      mode: "paper",
      activeStrategies: strategies.filter((strategy) => strategy.isActive).length,
      totalStrategies: strategies.length,
      recentTrades,
      openTrades: storage.getOpenTrades().length,
      currentMarket: await fetchCurrentBtcCandleMarket().catch(() => null),
      engine: engineState,
    });
  });

  let engineTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleEngine = () => {
    const intervalSec = Math.max(5, parseInt(storage.getSetting("polling_interval") || "15", 10));
    engineTimer = setTimeout(async () => {
      try {
        await runEngineOnce();
      } catch {
        // Guard the long-running poll loop.
      }
      scheduleEngine();
    }, intervalSec * 1000);
  };

  if (!engineTimer) {
    scheduleEngine();
  }

  app.get("/api/engine/status", (_req, res) => {
    res.json({
      running: true,
      mode: "paper",
      pollingIntervalSec: Math.max(5, parseInt(storage.getSetting("polling_interval") || "15", 10)),
      activeStrategies: storage.getStrategies().filter((strategy) => strategy.isActive).length,
      openTrades: storage.getOpenTrades().length,
      circuitBreaker: storage.getSetting("circuit_breaker") || "ok",
      lastPollAt: engineState.lastPollAt,
      lastPollOutcome: engineState.lastPollOutcome,
      lastSignalAt: engineState.lastSignalAt,
      lastSignalStrategy: engineState.lastSignalStrategy,
      lastSignalReason: engineState.lastSignalReason,
      currentMarketId: engineState.currentMarketId,
      currentConditionId: engineState.currentConditionId,
      currentMarketQuestion: engineState.currentMarketQuestion,
      currentMarketEndsAt: engineState.currentMarketEndsAt,
      currentYesPrice: engineState.currentYesPrice,
      currentNoPrice: engineState.currentNoPrice,
      strategyDiagnostics: engineState.strategyDiagnostics,
      managerDecision: engineState.managerDecision,
      marketDebug: engineState.marketDebug,
    });
  });

  return httpServer;
}
