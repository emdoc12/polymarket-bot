import type { Express } from "express";
import { type Server } from "http";
import { storage } from "./storage";
import { insertStrategySchema, insertWatchlistSchema, type Strategy, type TradeLog } from "@shared/schema";

const GAMMA_API = "https://gamma-api.polymarket.com";
const CLOB_API = "https://clob.polymarket.com";

const ROLLING_CRYPTO_MARKETS = [
  { symbol: "BTC", slugPrefix: "btc-updown-5m", names: ["bitcoin", "btc"] },
  { symbol: "ETH", slugPrefix: "eth-updown-5m", names: ["ethereum", "eth"] },
  { symbol: "SOL", slugPrefix: "sol-updown-5m", names: ["solana", "sol"] },
  { symbol: "XRP", slugPrefix: "xrp-updown-5m", names: ["xrp"] },
  { symbol: "BNB", slugPrefix: "bnb-updown-5m", names: ["bnb"] },
  { symbol: "DOGE", slugPrefix: "doge-updown-5m", names: ["dogecoin", "doge"] },
  { symbol: "HYPE", slugPrefix: "hype-updown-5m", names: ["hyperliquid", "hype"] },
];

function getRollingCryptoMarketsForScan() {
  return storage.getSetting("enable_multi_asset_markets") === "true"
    ? ROLLING_CRYPTO_MARKETS
    : ROLLING_CRYPTO_MARKETS.slice(0, 1);
}

type PolyMarket = {
  id: string;
  question?: string;
  conditionId?: string;
  clobTokenIds?: string | null;
  outcomePrices?: string | null;
  outcomes?: string | null;
  eventStartTime?: string;
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
  _assetSymbol?: string;
  events?: { title?: string; image?: string }[];
};

type PolyEvent = {
  id: string;
  title?: string;
  image?: string;
  eventStartTime?: string;
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

type TradeSignal = {
  side: "YES" | "NO";
  score: number;
  reason: string;
  arb?: {
    yesPrice: number;
    noPrice: number;
    yesSize: number;
    noSize: number;
    shares: number;
    netProfit: number;
    netEdgePct: number;
    totalCost: number;
    totalFees: number;
  };
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
  currentMarketRawQuestion: string | null;
  currentMarketEndsAt: string | null;
  currentMarketTimeLeftSec: number | null;
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
    selectorTarget: string | null;
    selectorCandidates: string[];
    selectorWinner: string | null;
  };
};

type StrategyRuntimeConfig = Record<string, number>;

const ORDERBOOK_OPTIMIZER_PROFILES = [
  {
    name: "current",
    config: {},
  },
  {
    name: "tight",
    config: {
      minImbalanceThreshold: 0.28,
      imbalanceThreshold: 0.45,
      maxEntryPrice: 0.56,
      hardMaxEntryPrice: 0.68,
      minAgentScore: 0.018,
    },
  },
  {
    name: "balanced",
    config: {
      minImbalanceThreshold: 0.18,
      imbalanceThreshold: 0.32,
      maxEntryPrice: 0.62,
      hardMaxEntryPrice: 0.76,
      minAgentScore: 0.01,
    },
  },
  {
    name: "active",
    config: {
      minImbalanceThreshold: 0.1,
      imbalanceThreshold: 0.22,
      maxEntryPrice: 0.68,
      hardMaxEntryPrice: 0.82,
      minAgentScore: 0.006,
    },
  },
  {
    name: "scalp",
    config: {
      minImbalanceThreshold: 0.06,
      imbalanceThreshold: 0.16,
      maxEntryPrice: 0.72,
      hardMaxEntryPrice: 0.86,
      minAgentScore: 0.004,
      takeProfitPct: 0.008,
      stopLossPct: 0.008,
      minHoldSeconds: 5,
      forceExitSecondsLeft: 12,
    },
  },
];

const FIXED_STRATEGIES = [
  {
    name: "Pure YES/NO Arbitrage",
    marketQuestion: "Bitcoin Up or Down - 5 Minutes (auto-roll)",
    side: "YES" as const,
    triggerType: "price_below",
    triggerPrice: 0.99,
    orderSize: 10,
    orderType: "MARKET",
    cooldownMinutes: 1,
    isActive: false,
    autoRoll: true,
    config: JSON.stringify({
      maxPairCost: 0.985,
      minNetEdgePct: 0.005,
      minProfitUsdc: 0.25,
      minSecondsLeft: 20,
      description: "Paper-buy matched YES and NO shares when executable asks lock a guaranteed net profit after fees.",
    }),
  },
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
      minImbalanceThreshold: 0.12,
      imbalanceThreshold: 0.18,
      maxEntryPrice: 0.56,
      hardMaxEntryPrice: 0.72,
      minSecondsLeft: 40,
      minAgentScore: 0.015,
      takeProfitPct: 0.012,
      stopLossPct: 0.01,
      forceExitSecondsLeft: 18,
      minHoldSeconds: 8,
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
  currentMarketRawQuestion: null,
  currentMarketEndsAt: null,
  currentMarketTimeLeftSec: null,
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
    selectorTarget: null,
    selectorCandidates: [],
    selectorWinner: null,
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

function getStrategyNumberConfig(config: StrategyRuntimeConfig, key: string, fallback: number) {
  const raw = config[key];
  return typeof raw === "number" && Number.isFinite(raw) ? raw : fallback;
}

function getStrategyCooldownMs(strategy: Strategy) {
  const config = parseStrategyConfig(strategy);
  const configuredSeconds = getStrategyNumberConfig(config, "cooldownSeconds", NaN);
  if (Number.isFinite(configuredSeconds)) {
    return Math.max(2, configuredSeconds) * 1000;
  }
  const cooldownMinutes = Math.max(0, strategy.cooldownMinutes ?? 0);
  if (strategy.autoRoll) {
    return Math.min(Math.max(5, cooldownMinutes * 60), 15) * 1000;
  }
  return Math.max(1, cooldownMinutes) * 60 * 1000;
}

function getCurrentEasternParts() {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });
  const parts = formatter.formatToParts(new Date());
  const get = (type: string) => parts.find((part) => part.type === type)?.value || "";
  return {
    year: Number(get("year")),
    monthName: get("month"),
    day: Number(get("day")),
    hour: Number(get("hour")),
    minute: Number(get("minute")),
    second: Number(get("second")),
    dayPeriod: get("dayPeriod").toUpperCase(),
  };
}

function monthNameToNumber(name: string) {
  const months = [
    "january", "february", "march", "april", "may", "june",
    "july", "august", "september", "october", "november", "december",
  ];
  return months.indexOf(name.toLowerCase()) + 1;
}

function parseClockToMinutes(raw: string) {
  const match = raw.trim().match(/^(\d{1,2}):(\d{2})(AM|PM)$/i);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  const ampm = match[3].toUpperCase();
  if (ampm === "AM" && hour === 12) hour = 0;
  if (ampm === "PM" && hour !== 12) hour += 12;
  return hour * 60 + minute;
}

function formatEtClockFromMinutes(totalMinutes: number) {
  const normalized = ((totalMinutes % 1440) + 1440) % 1440;
  const hour24 = Math.floor(normalized / 60);
  const minute = normalized % 60;
  const ampm = hour24 >= 12 ? "PM" : "AM";
  let hour12 = hour24 % 12;
  if (hour12 === 0) hour12 = 12;
  return `${hour12}:${String(minute).padStart(2, "0")}${ampm}`;
}

function getComparableEtMinute(year: number, month: number, day: number, minutes: number) {
  return (((year * 100) + month) * 100 + day) * 1440 + minutes;
}

function getCurrentComparableEtMinute() {
  const easternNow = getCurrentEasternParts();
  const nowMinutes = parseClockToMinutes(
    `${easternNow.hour}:${String(easternNow.minute).padStart(2, "0")}${easternNow.dayPeriod}`,
  ) ?? 0;
  return getComparableEtMinute(
    easternNow.year,
    monthNameToNumber(easternNow.monthName),
    easternNow.day,
    nowMinutes,
  );
}

function getCurrentEtWindowTarget() {
  const easternNow = getCurrentEasternParts();
  const month = monthNameToNumber(easternNow.monthName);
  const nowMinutes = parseClockToMinutes(
    `${easternNow.hour}:${String(easternNow.minute).padStart(2, "0")}${easternNow.dayPeriod}`,
  ) ?? 0;
  const bucketStart = Math.floor(nowMinutes / 5) * 5;
  const bucketEnd = bucketStart + 5;
  return {
    year: easternNow.year,
    month,
    monthName: easternNow.monthName,
    day: easternNow.day,
    bucketStart,
    bucketEnd,
    timeFragment: `${formatEtClockFromMinutes(bucketStart)}-${formatEtClockFromMinutes(bucketEnd)} ET`,
    titleFragment: `${easternNow.monthName} ${easternNow.day}, ${formatEtClockFromMinutes(bucketStart)}-${formatEtClockFromMinutes(bucketEnd)} ET`,
  };
}

function parseBtcTitleWindow(title?: string) {
  if (!title) return null;
  const match = title.match(/-\s*([A-Za-z]+)\s+(\d{1,2}),\s*(\d{1,2}:\d{2}[AP]M)\s*-\s*(\d{1,2}:\d{2}[AP]M)\s*ET/i);
  if (!match) return null;
  const easternNow = getCurrentEasternParts();
  const month = monthNameToNumber(match[1]);
  const day = Number(match[2]);
  const startMinutes = parseClockToMinutes(match[3].toUpperCase());
  const endMinutes = parseClockToMinutes(match[4].toUpperCase());
  if (!month || startMinutes == null || endMinutes == null) return null;
  const year = easternNow.year;
  const currentEtMonth = monthNameToNumber(easternNow.monthName);
  const currentEtDay = easternNow.day;
  const normalizedEnd = endMinutes <= startMinutes ? endMinutes + 1440 : endMinutes;
  const startComparable = getComparableEtMinute(year, currentEtMonth, currentEtDay, startMinutes);
  const endComparable = getComparableEtMinute(year, currentEtMonth, currentEtDay, normalizedEnd);
  return {
    year,
    month,
    day,
    effectiveMonth: currentEtMonth,
    effectiveDay: currentEtDay,
    startMinutes,
    endMinutes,
    durationMinutes: normalizedEnd - startMinutes,
    startComparable,
    endComparable,
  };
}

function formatTitleWithCurrentEtDate(title: string) {
  const window = parseBtcTitleWindow(title);
  if (!window) return title;
  const easternNow = getCurrentEasternParts();
  return title.replace(
    /-\s*[A-Za-z]+\s+\d{1,2},\s*(\d{1,2}:\d{2}[AP]M)\s*-\s*(\d{1,2}:\d{2}[AP]M)\s*ET/i,
    `- ${easternNow.monthName} ${easternNow.day}, $1-$2 ET`,
  );
}

function getMarketTitle(market: PolyMarket) {
  const titles = [market.question, market._eventTitle]
    .filter((title): title is string => Boolean(title));
  if (titles.length === 0) return "BTC 5-minute market";
  const currentComparable = getCurrentComparableEtMinute();
  return titles.sort((a, b) => {
    const aWindow = parseBtcTitleWindow(a);
    const bWindow = parseBtcTitleWindow(b);
    if (!aWindow && !bWindow) return 0;
    if (!aWindow) return 1;
    if (!bWindow) return -1;
    const aDistance = currentComparable < aWindow.startComparable
      ? aWindow.startComparable - currentComparable
      : currentComparable >= aWindow.endComparable
        ? currentComparable - aWindow.endComparable
        : 0;
    const bDistance = currentComparable < bWindow.startComparable
      ? bWindow.startComparable - currentComparable
      : currentComparable >= bWindow.endComparable
        ? currentComparable - bWindow.endComparable
        : 0;
    return aDistance - bDistance;
  })[0];
}

function getMarketWindow(market: PolyMarket) {
  const windows = [parseBtcTitleWindow(market.question), parseBtcTitleWindow(market._eventTitle)]
    .filter((window) => window != null);
  if (windows.length === 0) return null;
  const currentComparable = getCurrentComparableEtMinute();
  return windows.sort((a, b) => {
    const aDistance = currentComparable < a!.startComparable
      ? a!.startComparable - currentComparable
      : currentComparable >= a!.endComparable
        ? currentComparable - a!.endComparable
        : 0;
    const bDistance = currentComparable < b!.startComparable
      ? b!.startComparable - currentComparable
      : currentComparable >= b!.endComparable
        ? currentComparable - b!.endComparable
        : 0;
    return aDistance - bDistance;
  })[0] || null;
}

function getTitleWindowTimeLeftSec(title?: string) {
  const window = parseBtcTitleWindow(title);
  if (!window) return null;
  const easternNow = getCurrentEasternParts();
  const nowComparable = getCurrentComparableEtMinute();
  const secondsLeft = ((window.endComparable - nowComparable) * 60) - easternNow.second;
  return Math.max(0, secondsLeft);
}

function getMarketWindowTimeLeftSec(market: PolyMarket) {
  const window = getMarketWindow(market);
  if (!window) return null;
  const easternNow = getCurrentEasternParts();
  const nowComparable = getCurrentComparableEtMinute();
  const secondsLeft = ((window.endComparable - nowComparable) * 60) - easternNow.second;
  return Math.max(0, secondsLeft);
}

function eventLooksLikeRollingBtcCandle(event: PolyEvent) {
  const title = event.title;
  const normalized = (title || "").toLowerCase();
  const hasCrypto = getRollingCryptoMarketsForScan().some((asset) => asset.names.some((name) => normalized.includes(name)));
  const hasUpDown = normalized.includes("up") && normalized.includes("down");
  const hasMinute = normalized.includes("minute") || normalized.includes("min");
  const hasFive = normalized.includes("5 minute") || normalized.includes("5-minute") || normalized.includes("5 min");
  const hasExplicitTimeRange = /\b\d{1,2}:\d{2}\s?(am|pm)?\s*-\s*\d{1,2}:\d{2}\s?(am|pm)?/i.test(title || "");
  const effectiveStart = event.eventStartTime || event.startDate;
  const durationMs = effectiveStart && event.endDate
    ? new Date(event.endDate).getTime() - new Date(effectiveStart).getTime()
    : null;
  const looksLikeShortRollingWindow = durationMs != null && durationMs > 0 && durationMs <= 6 * 60 * 1000;
  return (
    hasCrypto &&
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
    getRollingCryptoMarketsForScan().some((asset) => asset.names.some((name) => normalized.includes(name))) &&
    (normalized.includes("minute") || normalized.includes("min") || normalized.includes("up") || normalized.includes("down"))
  );
}

function marketLooksLikeRollingBtcCandle(market: PolyMarket) {
  const titles = [
    market.question,
    market._eventTitle,
    ...(Array.isArray(market.events) ? market.events.map((event) => event.title) : []),
  ].filter((title): title is string => Boolean(title));

  return titles.some((title) => {
    const normalized = title.toLowerCase();
    const hasCrypto = getRollingCryptoMarketsForScan().some((asset) => asset.names.some((name) => normalized.includes(name)));
    const hasUpDown = normalized.includes("up") && normalized.includes("down");
    const window = parseBtcTitleWindow(title);
    return hasCrypto && hasUpDown && window != null && window.durationMinutes === 5;
  });
}

function getMarketAssetSymbol(market: PolyMarket) {
  if (market._assetSymbol) return market._assetSymbol;
  const title = getMarketTitle(market).toLowerCase();
  return ROLLING_CRYPTO_MARKETS.find((asset) => asset.names.some((name) => title.includes(name)))?.symbol || "BTC";
}

function normalizeDirectMarket(market: PolyMarket): PolyMarket {
  const eventTitle = Array.isArray(market.events)
    ? market.events.find((event) => event.title)?.title
    : undefined;
  const eventImage = Array.isArray(market.events)
    ? market.events.find((event) => event.image)?.image
    : undefined;
  return {
    ...market,
    _eventTitle: eventTitle || market._eventTitle,
    _eventImage: eventImage || market._eventImage,
    _assetSymbol: getMarketAssetSymbol({ ...market, _eventTitle: eventTitle || market._eventTitle }),
  };
}

function getCurrentUtcBucketSeconds(offsetBuckets = 0) {
  const bucketMs = 5 * 60 * 1000;
  return Math.floor(Date.now() / bucketMs) * 300 + (offsetBuckets * 300);
}

async function fetchBtcMarketBySlugBuckets() {
  const offsets = [0, 1, -1, 2];
  const results: PolyMarket[] = [];
  for (const asset of getRollingCryptoMarketsForScan()) {
    for (const offset of offsets) {
      const slug = `${asset.slugPrefix}-${getCurrentUtcBucketSeconds(offset)}`;
      try {
        const markets = await polyFetch(GAMMA_API, "/markets", { slug }) as PolyMarket[];
        if (Array.isArray(markets)) {
          for (const market of markets) {
            results.push(normalizeDirectMarket({ ...market, _assetSymbol: asset.symbol }));
          }
        }
      } catch {
        continue;
      }
    }
  }
  return results.filter(marketLooksLikeRollingBtcCandle);
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
      eventStartTime: event.eventStartTime,
      startDate: event.startDate,
      endDate: event.endDate,
      image: event.image,
      _eventTitle: event.title,
      _eventImage: event.image,
    }];
  }
  return markets.map((market) => ({
    ...market,
    eventStartTime: market.eventStartTime || event.eventStartTime,
    startDate: market.startDate || event.startDate,
    endDate: market.endDate || event.endDate,
    _eventTitle: event.title,
    _eventImage: event.image,
  }));
}

function pickCurrentOrNextMarket(markets: PolyMarket[]) {
  const currentWindow = getCurrentEtWindowTarget();
  const currentComparable = getComparableEtMinute(
    currentWindow.year,
    currentWindow.month,
    currentWindow.day,
    currentWindow.bucketStart,
  );
  engineState.marketDebug.selectorTarget = currentWindow.timeFragment;
  engineState.marketDebug.selectorCandidates = [];
  engineState.marketDebug.selectorWinner = null;

  const titleTimedMarkets = markets
    .map((market) => ({ market, window: getMarketWindow(market) }))
    .filter((entry) => entry.window != null && entry.window.durationMinutes === 5);

  if (titleTimedMarkets.length > 0) {
    const getDistance = (entry: (typeof titleTimedMarkets)[number]) => {
      const window = entry.window!;
      if (currentComparable < window.startComparable) return window.startComparable - currentComparable;
      if (currentComparable >= window.endComparable) return currentComparable - window.endComparable;
      return 0;
    };
    const rankedByCurrentBucket = [...titleTimedMarkets].sort((a, b) => {
      const aLive = a.window!.startComparable <= currentComparable && currentComparable < a.window!.endComparable;
      const bLive = b.window!.startComparable <= currentComparable && currentComparable < b.window!.endComparable;
      if (aLive !== bLive) return aLive ? -1 : 1;
      const aUpcoming = a.window!.startComparable > currentComparable;
      const bUpcoming = b.window!.startComparable > currentComparable;
      if (aUpcoming !== bUpcoming) return aUpcoming ? -1 : 1;
      const aDistance = getDistance(a);
      const bDistance = getDistance(b);
      if (aDistance !== bDistance) return aDistance - bDistance;
      return b.window!.startComparable - a.window!.startComparable;
    });
    engineState.marketDebug.selectorCandidates = rankedByCurrentBucket
      .slice(0, 12)
      .map((entry) => {
        const distance = getDistance(entry);
        const state = entry.window!.startComparable <= currentComparable && currentComparable < entry.window!.endComparable
          ? "live"
          : entry.window!.startComparable > currentComparable
            ? "upcoming"
            : "expired";
        return `${formatTitleWithCurrentEtDate(getMarketTitle(entry.market))} | ${state} | distance=${distance}m`;
      });

    const liveMarket = rankedByCurrentBucket.find(
      (entry) => entry.window!.startComparable <= currentComparable && currentComparable < entry.window!.endComparable,
    );
    if (liveMarket) {
      engineState.marketDebug.selectorWinner = formatTitleWithCurrentEtDate(getMarketTitle(liveMarket.market));
      return liveMarket.market;
    }

    const upcomingMarket = rankedByCurrentBucket.find((entry) => entry.window!.startComparable > currentComparable);
    if (upcomingMarket) {
      engineState.marketDebug.selectorWinner = `waiting_for_live_bucket; next=${formatTitleWithCurrentEtDate(getMarketTitle(upcomingMarket.market))}`;
      return null;
    }

    engineState.marketDebug.selectorWinner = "waiting_for_live_bucket; all_candidates_expired";
    return null;
  }

  const now = Date.now();
  const futureMarkets = markets.filter((market) => market.endDate && new Date(market.endDate).getTime() > now);
  const currentlyLive = futureMarkets
    .filter((market) => {
      const effectiveStart = market.eventStartTime || market.startDate;
      if (!effectiveStart || !market.endDate) return false;
      const startMs = new Date(effectiveStart).getTime();
      const endMs = new Date(market.endDate).getTime();
      return startMs <= now && now < endMs;
    })
    .sort(entrySortByEnd);

  if (currentlyLive.length > 0) {
    engineState.marketDebug.selectorWinner = formatTitleWithCurrentEtDate(getMarketTitle(currentlyLive[0]));
    return currentlyLive[0];
  }

  const upcoming = futureMarkets
    .sort((a, b) => {
      const aStart = new Date(a.eventStartTime || a.startDate || a.endDate || 0).getTime();
      const bStart = new Date(b.eventStartTime || b.startDate || b.endDate || 0).getTime();
      return aStart - bStart;
    });

  engineState.marketDebug.selectorWinner = upcoming[0] ? formatTitleWithCurrentEtDate(getMarketTitle(upcoming[0])) : null;
  return upcoming[0] || null;
}

function entrySortByEnd(a: PolyMarket, b: PolyMarket) {
  return new Date(a.endDate || 0).getTime() - new Date(b.endDate || 0).getTime();
}

async function fetchCurrentBtcCandleMarket() {
  const slugMarkets = await fetchBtcMarketBySlugBuckets();
  if (slugMarkets.length > 0) {
    engineState.marketDebug.btcCandidateTitles = slugMarkets
      .map((market) => getMarketTitle(market))
      .slice(0, 8);
    engineState.marketDebug.matchedEventTitles = slugMarkets
      .map((market) => getMarketTitle(market))
      .slice(0, 8);

    const slugMarket = pickCurrentOrNextMarket(slugMarkets);
    if (slugMarket) {
      return slugMarket;
    }
  }

  const directMarkets = await polyFetch(GAMMA_API, "/markets", {
    limit: "250",
    offset: "0",
    active: "true",
    closed: "false",
    order: "createdAt",
    ascending: "false",
  }).catch(() => []) as PolyMarket[];

  const normalizedDirectMarkets = (Array.isArray(directMarkets) ? directMarkets : [])
    .map(normalizeDirectMarket);
  const directBtcMarkets = normalizedDirectMarkets.filter(marketLooksLikeRollingBtcCandle);

  if (directBtcMarkets.length > 0) {
    engineState.marketDebug.btcCandidateTitles = normalizedDirectMarkets
      .filter((market) => eventLooksBtcRelated(getMarketTitle(market)))
      .map((market) => getMarketTitle(market))
      .slice(0, 8);
    engineState.marketDebug.matchedEventTitles = directBtcMarkets
      .map((market) => getMarketTitle(market))
      .slice(0, 8);

    const directMarket = pickCurrentOrNextMarket(directBtcMarkets);
    return directMarket;
  }

  const events = await polyFetch(GAMMA_API, "/events", {
    limit: "200",
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

function parseBookLevel(level: any) {
  const price = parseFloat(level?.price ?? level?.p ?? "0");
  const size = parseFloat(level?.size ?? level?.quantity ?? level?.q ?? "0");
  return {
    price,
    size,
  };
}

function getBookLevels(book: any, side: "asks" | "bids") {
  const levels = Array.isArray(book?.[side]) ? book[side] : [];
  return levels
    .map(parseBookLevel)
    .filter((level: { price: number; size: number }) =>
      Number.isFinite(level.price) &&
      Number.isFinite(level.size) &&
      level.price > 0 &&
      level.size > 0,
    );
}

function getBestAsk(book: any) {
  const asks = getBookLevels(book, "asks");
  if (asks.length === 0) return null;
  return asks.reduce((best: { price: number; size: number } | null, level: { price: number; size: number }) => {
    if (!best || level.price < best.price) return level;
    return best;
  }, null);
}

function getOrderbookRangeConfig(strategy: Strategy) {
  const config = parseStrategyConfig(strategy);
  const targetImbalance = Number(config.imbalanceThreshold ?? 0.18);
  const minImbalance = Number(config.minImbalanceThreshold ?? Math.min(targetImbalance, 0.18));
  const targetMaxEntry = Number(config.maxEntryPrice ?? 0.56);
  const hardMaxEntry = Number(config.hardMaxEntryPrice ?? Math.max(targetMaxEntry, 0.72));
  return {
    config,
    minImbalance: Math.max(0, Math.min(minImbalance, targetImbalance)),
    targetImbalance: Math.max(0, targetImbalance),
    targetMaxEntry: clampProbability(targetMaxEntry),
    hardMaxEntry: clampProbability(Math.max(targetMaxEntry, hardMaxEntry)),
  };
}

function describeOrderbookState(strategy: Strategy, snapshot: PriceSnapshot) {
  const { config, minImbalance, targetImbalance, targetMaxEntry, hardMaxEntry } = getOrderbookRangeConfig(strategy);
  const yesPrice = clampProbability(snapshot.yesMid);
  const noPrice = clampProbability(snapshot.noMid, 1 - yesPrice);
  const yesBidDepth = sumBookSize(snapshot.yesBook?.bids);
  const noBidDepth = sumBookSize(snapshot.noBook?.bids);
  const totalDepth = yesBidDepth + noBidDepth;
  const minAgentScore = Number(config.minAgentScore ?? 0.015);

  if (totalDepth <= 0) {
    return "No usable YES/NO bid depth from the order book";
  }

  const imbalance = (yesBidDepth - noBidDepth) / totalDepth;
  const favoredSide = imbalance >= 0 ? "YES" : "NO";
  const favoredPrice = favoredSide === "YES" ? yesPrice : noPrice;
  const thresholdBlocked = Math.abs(imbalance) < minImbalance;
  const priceBlocked = favoredPrice > hardMaxEntry;
  const pieces = [
    `${favoredSide} book imbalance ${(Math.abs(imbalance) * 100).toFixed(1)}% vs ${(minImbalance * 100).toFixed(1)}%-${(targetImbalance * 100).toFixed(1)}% range`,
    `${favoredSide} price ${(favoredPrice * 100).toFixed(1)}% vs ${(targetMaxEntry * 100).toFixed(1)}%-${(hardMaxEntry * 100).toFixed(1)}% range`,
    `min edge ${(minAgentScore * 100).toFixed(1)}%`,
  ];

  if (thresholdBlocked && priceBlocked) return `${pieces.join("; ")}; blocked by imbalance and price`;
  if (thresholdBlocked) return `${pieces.join("; ")}; blocked by imbalance`;
  if (priceBlocked) return `${pieces.join("; ")}; blocked by price cap`;
  return `${pieces.join("; ")}; below after-fee edge score`;
}

function buildStrategyWithConfig(strategy: Strategy, overrides: Record<string, number>) {
  const config = { ...parseStrategyConfig(strategy), ...overrides };
  return {
    ...strategy,
    config: JSON.stringify(config),
  } as Strategy;
}

function evaluatePureArbitrage(
  strategy: Strategy,
  market: PolyMarket,
  snapshot: PriceSnapshot,
  orderSize: number,
) {
  const config = parseStrategyConfig(strategy);
  const timeLeftMs = market.endDate ? new Date(market.endDate).getTime() - Date.now() : 0;
  const secondsLeft = Math.max(0, Math.floor(timeLeftMs / 1000));
  const minSecondsLeft = Number(config.minSecondsLeft ?? 20);
  if (secondsLeft < minSecondsLeft) return null;

  const yesAsk = getBestAsk(snapshot.yesBook);
  const noAsk = getBestAsk(snapshot.noBook);
  if (!yesAsk || !noAsk) return null;

  const yesPrice = clampProbability(yesAsk.price);
  const noPrice = clampProbability(noAsk.price);
  const pairCost = yesPrice + noPrice;
  const maxPairCost = Number(config.maxPairCost ?? 0.985);
  if (pairCost > maxPairCost) return null;

  const feeRate = parseFloat(storage.getSetting("taker_fee_rate") || "0.072");
  const maxSharesByBudget = orderSize / pairCost;
  const shares = Math.min(maxSharesByBudget, yesAsk.size, noAsk.size);
  if (!Number.isFinite(shares) || shares <= 0) return null;

  const yesSize = shares * yesPrice;
  const noSize = shares * noPrice;
  const totalCost = yesSize + noSize;
  const yesFee = calculateTakerFee(yesSize, yesPrice, feeRate);
  const noFee = calculateTakerFee(noSize, noPrice, feeRate);
  const totalFees = yesFee + noFee;
  const netProfit = shares - totalCost - totalFees;
  const netEdgePct = totalCost > 0 ? netProfit / totalCost : 0;
  const minNetEdgePct = Number(config.minNetEdgePct ?? 0.005);
  const minProfitUsdc = Number(config.minProfitUsdc ?? 0.25);

  if (netProfit < minProfitUsdc || netEdgePct < minNetEdgePct) {
    return null;
  }

  return {
    side: "YES" as const,
    score: netEdgePct,
    reason: `Pure arb YES ${yesPrice.toFixed(3)} + NO ${noPrice.toFixed(3)} = ${pairCost.toFixed(3)}; locked +${netProfit.toFixed(2)} USDC (${(netEdgePct * 100).toFixed(2)}%) after fees`,
    arb: {
      yesPrice,
      noPrice,
      yesSize,
      noSize,
      shares,
      netProfit,
      netEdgePct,
      totalCost,
      totalFees,
    },
  };
}

function describePureArbState(strategy: Strategy, snapshot: PriceSnapshot, orderSize: number) {
  const config = parseStrategyConfig(strategy);
  const yesAsk = getBestAsk(snapshot.yesBook);
  const noAsk = getBestAsk(snapshot.noBook);
  if (!yesAsk || !noAsk) return "Missing executable YES/NO asks";

  const yesPrice = clampProbability(yesAsk.price);
  const noPrice = clampProbability(noAsk.price);
  const pairCost = yesPrice + noPrice;
  const maxPairCost = Number(config.maxPairCost ?? 0.985);
  const feeRate = parseFloat(storage.getSetting("taker_fee_rate") || "0.072");
  const shares = Math.min(orderSize / pairCost, yesAsk.size, noAsk.size);
  const yesSize = shares * yesPrice;
  const noSize = shares * noPrice;
  const totalCost = yesSize + noSize;
  const totalFees = calculateTakerFee(yesSize, yesPrice, feeRate) + calculateTakerFee(noSize, noPrice, feeRate);
  const netProfit = shares - totalCost - totalFees;
  const netEdgePct = totalCost > 0 ? netProfit / totalCost : 0;

  return `YES ask ${(yesPrice * 100).toFixed(1)}% + NO ask ${(noPrice * 100).toFixed(1)}% = ${(pairCost * 100).toFixed(1)}% vs ${(maxPairCost * 100).toFixed(1)}% cap; net ${netProfit.toFixed(2)} USDC (${(netEdgePct * 100).toFixed(2)}%)`;
}

async function optimizeOrderbookStrategy(
  strategy: Strategy,
  market: PolyMarket,
  snapshot: PriceSnapshot,
  candles: any[],
) {
  if (strategy.name !== "Orderbook Arbitrage & Imbalance" || storage.getSetting("enable_orderbook_optimizer") === "false") {
    const strictSignal = await evaluateSignal(strategy, market, snapshot, candles);
    const signal = strictSignal ?? evaluateAgentOpinion(strategy, market, snapshot, candles);
    return {
      strategy,
      profileName: "manual",
      signal,
      scanned: 1,
      bestRejectedStrategy: strategy,
    };
  }

  let best: {
    strategy: Strategy;
    profileName: string;
    signal: TradeSignal;
  } | null = null;
  let bestRejectedStrategy = strategy;
  let bestRejectedScore = Number.NEGATIVE_INFINITY;

  for (const profile of ORDERBOOK_OPTIMIZER_PROFILES) {
    const candidate = buildStrategyWithConfig(strategy, profile.config);
    const strictSignal = await evaluateSignal(candidate, market, snapshot, candles);
    const agentSignal = strictSignal ?? evaluateAgentOpinion(candidate, market, snapshot, candles);
    if (agentSignal) {
      const profilePenalty = profile.name === "current" ? 0 : 0.002;
      const adjustedSignal = {
        ...agentSignal,
        score: agentSignal.score - profilePenalty,
        reason: `${profile.name} profile: ${agentSignal.reason}`,
      };
      if (!best || adjustedSignal.score > best.signal.score) {
        best = { strategy: candidate, profileName: profile.name, signal: adjustedSignal };
      }
      continue;
    }

    const { minImbalance, targetImbalance, targetMaxEntry, hardMaxEntry } = getOrderbookRangeConfig(candidate);
    const yesPrice = clampProbability(snapshot.yesMid);
    const noPrice = clampProbability(snapshot.noMid, 1 - yesPrice);
    const yesBidDepth = sumBookSize(snapshot.yesBook?.bids);
    const noBidDepth = sumBookSize(snapshot.noBook?.bids);
    const totalDepth = yesBidDepth + noBidDepth;
    if (totalDepth <= 0) continue;
    const imbalance = Math.abs((yesBidDepth - noBidDepth) / totalDepth);
    const favoredPrice = yesBidDepth >= noBidDepth ? yesPrice : noPrice;
    const nearMissScore = imbalance - minImbalance
      - Math.max(0, favoredPrice - hardMaxEntry)
      - Math.max(0, targetImbalance - imbalance) * 0.2
      - Math.max(0, favoredPrice - targetMaxEntry) * 0.2;
    if (nearMissScore > bestRejectedScore) {
      bestRejectedScore = nearMissScore;
      bestRejectedStrategy = candidate;
    }
  }

  return {
    strategy: best?.strategy ?? strategy,
    profileName: best?.profileName ?? null,
    signal: best?.signal ?? null,
    scanned: ORDERBOOK_OPTIMIZER_PROFILES.length,
    bestRejectedStrategy,
  };
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

async function fetchRecentCryptoCandles(symbol = "BTC", limit = 15) {
  const safeSymbol = /^[A-Z0-9]+$/.test(symbol) ? symbol : "BTC";
  const response = await fetch(
    `https://min-api.cryptocompare.com/data/v2/histominute?fsym=${safeSymbol}&tsym=USD&limit=${limit}`,
    { signal: AbortSignal.timeout(6000) },
  );
  if (!response.ok) throw new Error(`Failed to fetch ${safeSymbol} spot candles`);
  const data = await response.json();
  const rows = data?.Data?.Data;
  return Array.isArray(rows) ? rows : [];
}

async function fetchRecentBtcCandles(limit = 15) {
  return fetchRecentCryptoCandles("BTC", limit);
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

function getCurrentMarkedPriceForTrade(trade: TradeLog, snapshot: PriceSnapshot) {
  if (trade.outcome === "YES") return snapshot.yesMid != null ? clampProbability(snapshot.yesMid) : null;
  if (trade.outcome === "NO") return snapshot.noMid != null ? clampProbability(snapshot.noMid) : null;
  return null;
}

function getMarkedTradePnl(trade: TradeLog, markPrice: number, feeRate: number) {
  const entryPrice = clampProbability(trade.price);
  const shares = trade.size / entryPrice;
  const proceeds = shares * clampProbability(markPrice);
  const grossPnl = proceeds - trade.size;
  const entryFee = trade.feePaid ?? calculateTakerFee(trade.size, entryPrice, feeRate);
  const exitFee = calculateTakerFee(proceeds, markPrice, feeRate);
  const netPnl = grossPnl - entryFee - exitFee;
  const pnlPercent = trade.size > 0 ? netPnl / trade.size : 0;
  return {
    shares,
    proceeds,
    grossPnl,
    entryFee,
    exitFee,
    netPnl,
    pnlPercent,
  };
}

function closePaperTradeAtMark(
  trade: TradeLog,
  strategy: Strategy | undefined,
  exitPrice: number,
  exitReason: string,
  feeRate: number,
) {
  const { grossPnl, entryFee, exitFee, netPnl, pnlPercent } = getMarkedTradePnl(trade, exitPrice, feeRate);
  storage.updateTradeLog(trade.id, {
    status: "closed",
    exitPrice,
    pnl: grossPnl,
    pnlPercent: pnlPercent * 100,
    feePaid: entryFee + exitFee,
    netPnl,
    errorMessage: `Paper exit (${exitReason}) at ${(exitPrice * 100).toFixed(1)}%`,
    closedAt: new Date().toISOString(),
  });

  if (trade.strategyId) {
    storage.updateStrategyPnl(trade.strategyId, netPnl, netPnl > 0);
  }
  const currentBalance = parseFloat(storage.getSetting("paper_balance") || "1000");
  storage.setSetting("paper_balance", String(currentBalance + netPnl));

  maybeTriggerDrawdownCircuitBreaker();

  return {
    strategyName: strategy?.name || trade.strategyName || "Unknown strategy",
    exitReason,
    netPnl,
    pnlPercent,
  };
}

function manageOpenTradesForCurrentMarket(
  market: PolyMarket,
  snapshot: PriceSnapshot,
  strategies: Strategy[],
) {
  const now = Date.now();
  const feeRate = parseFloat(storage.getSetting("taker_fee_rate") || "0.072");
  const secondsLeft = market.endDate
    ? Math.max(0, Math.floor((new Date(market.endDate).getTime() - now) / 1000))
    : 0;
  const strategyMap = new Map(strategies.map((strategy) => [strategy.id, strategy]));
  const currentTrades = storage.getOpenTrades().filter((trade) => trade.conditionId === market.conditionId);
  const closed: Array<{ strategyName: string; exitReason: string; netPnl: number; pnlPercent: number }> = [];

  for (const trade of currentTrades) {
    const strategy = trade.strategyId != null ? strategyMap.get(trade.strategyId) : undefined;
    if (strategy?.name === "Pure YES/NO Arbitrage" || trade.strategyName === "Pure YES/NO Arbitrage") {
      continue;
    }
    const config = strategy ? parseStrategyConfig(strategy) : {};
    const minHoldSeconds = getStrategyNumberConfig(config, "minHoldSeconds", 8);
    const takeProfitPct = getStrategyNumberConfig(config, "takeProfitPct", getStrategyNumberConfig(config, "tpPct", 0.012));
    const stopLossPct = getStrategyNumberConfig(config, "stopLossPct", getStrategyNumberConfig(config, "slPct", 0.01));
    const forceExitSecondsLeft = getStrategyNumberConfig(config, "forceExitSecondsLeft", 18);
    const scalpExitPct = getStrategyNumberConfig(config, "scalpExitPct", 0.005);
    const createdAt = new Date(trade.timestamp).getTime();
    const ageSeconds = Number.isFinite(createdAt) ? (now - createdAt) / 1000 : 0;
    const exitPrice = getCurrentMarkedPriceForTrade(trade, snapshot);
    if (exitPrice == null) continue;

    const marked = getMarkedTradePnl(trade, exitPrice, feeRate);
    const netReturn = marked.pnlPercent;
    let exitReason: string | null = null;

    if (ageSeconds >= minHoldSeconds && netReturn >= takeProfitPct) {
      exitReason = "take_profit";
    } else if (ageSeconds >= minHoldSeconds && netReturn <= -stopLossPct) {
      exitReason = "stop_loss";
    } else if (secondsLeft <= forceExitSecondsLeft && netReturn > 0) {
      exitReason = "late_profit_lock";
    } else if (secondsLeft <= Math.max(10, forceExitSecondsLeft) && netReturn >= scalpExitPct) {
      exitReason = "scalp_exit";
    }

    if (!exitReason) continue;
    closed.push(closePaperTradeAtMark(trade, strategy, exitPrice, exitReason, feeRate));
  }

  return {
    closed,
    summary: closed.length > 0
      ? closed.map((entry) => `${entry.strategyName}:${entry.exitReason}`).join(", ")
      : null,
  };
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

function drawdownStopsEnabled() {
  return storage.getSetting("enable_drawdown_circuit_breaker") === "true";
}

function maybeTriggerDrawdownCircuitBreaker() {
  if (!drawdownStopsEnabled()) return;
  const currentBalance = parseFloat(storage.getSetting("paper_balance") || "1000");
  const startOfDayBalance = parseFloat(storage.getSetting("day_start_balance") || String(currentBalance));
  const drawdownLimit = parseFloat(storage.getSetting("drawdown_limit") || "0.10");
  const drawdownPct = startOfDayBalance > 0 ? (startOfDayBalance - currentBalance) / startOfDayBalance : 0;
  if (drawdownPct >= drawdownLimit) {
    storage.setSetting("circuit_breaker", "triggered");
    storage.setSetting("circuit_breaker_at", new Date().toISOString());
  }
}

function getRecentStrategyResults(strategyId: number) {
  const trades = storage.getTradeLogsByStrategy(strategyId)
    .filter((trade) => trade.status === "closed" && trade.netPnl != null);
  const grouped = new Map<string, TradeLog[]>();
  const results: { netPnl: number; closedAt: string }[] = [];

  for (const trade of trades) {
    if (trade.tradeGroupId) {
      const legs = grouped.get(trade.tradeGroupId) ?? [];
      legs.push(trade);
      grouped.set(trade.tradeGroupId, legs);
    } else {
      results.push({
        netPnl: trade.netPnl ?? 0,
        closedAt: trade.closedAt || trade.timestamp,
      });
    }
  }

  for (const legs of grouped.values()) {
    if (!legs.every((leg) => leg.netPnl != null)) continue;
    results.push({
      netPnl: legs.reduce((sum, leg) => sum + (leg.netPnl ?? 0), 0),
      closedAt: legs[0]?.closedAt || legs[0]?.timestamp || new Date(0).toISOString(),
    });
  }

  return results.sort((a, b) => new Date(b.closedAt).getTime() - new Date(a.closedAt).getTime());
}

function calculateStrategySizing(strategy: Strategy, config: Record<string, any>, balance: number, maxOrderSize: number) {
  const legacyMaxRiskPct = Math.min(0.25, Math.max(0.01, parseFloat(storage.getSetting("max_risk_per_trade") || "0.08")));
  const dynamicSizingEnabled = storage.getSetting("enable_dynamic_sizing") === "true";
  const usePercentSizing = storage.getSetting("use_percent_sizing") !== "false";

  if (!dynamicSizingEnabled) {
    const riskCapSize = balance * legacyMaxRiskPct;
    const requestedSize = usePercentSizing ? riskCapSize : Number(config.orderSize ?? strategy.orderSize ?? riskCapSize);
    const orderSize = Math.min(requestedSize, maxOrderSize, riskCapSize);
    return {
      orderSize,
      detail: `Sizing ${orderSize.toFixed(2)} USDC (${(orderSize / balance * 100).toFixed(1)}% of paper balance)`,
    };
  }

  const basePct = Math.min(0.25, Math.max(0.001, parseFloat(storage.getSetting("base_position_pct") || "0.02")));
  const maxPct = Math.min(0.50, Math.max(basePct, parseFloat(storage.getSetting("max_position_pct") || "0.05")));
  const lossReducePct = Math.min(0.75, Math.max(0, parseFloat(storage.getSetting("loss_streak_reduce_pct") || "0.20")));
  const winIncreasePct = Math.min(0.75, Math.max(0, parseFloat(storage.getSetting("win_streak_increase_pct") || "0.10")));
  const recent = getRecentStrategyResults(strategy.id);

  let lossStreak = 0;
  let winStreak = 0;
  for (const result of recent) {
    const net = result.netPnl;
    if (net < 0 && winStreak === 0) {
      lossStreak += 1;
      continue;
    }
    if (net > 0 && lossStreak === 0) {
      winStreak += 1;
      continue;
    }
    break;
  }

  const lossMultiplier = lossStreak >= 3
    ? Math.pow(1 - lossReducePct, lossStreak - 2)
    : 1;
  const winMultiplier = winStreak >= 5
    ? Math.pow(1 + winIncreasePct, winStreak - 4)
    : 1;
  const dynamicPct = Math.min(maxPct, Math.max(0.001, basePct * lossMultiplier * winMultiplier));
  const riskCapSize = balance * maxPct;
  const requestedSize = balance * dynamicPct;
  const orderSize = Math.min(requestedSize, maxOrderSize, riskCapSize);
  return {
    orderSize,
    detail: `Dynamic sizing ${orderSize.toFixed(2)} USDC (${(dynamicPct * 100).toFixed(1)}% target, ${(maxPct * 100).toFixed(1)}% cap; W${winStreak}/L${lossStreak})`,
  };
}

function ensurePaperDefaults() {
  if (!storage.getSetting("paper_balance")) storage.setSetting("paper_balance", "1000");
  if (!storage.getSetting("day_start_balance")) storage.setSetting("day_start_balance", "1000");
  if (!storage.getSetting("taker_fee_rate")) storage.setSetting("taker_fee_rate", "0.072");
  if (!storage.getSetting("drawdown_limit")) storage.setSetting("drawdown_limit", "0.10");
  if (!storage.getSetting("enable_drawdown_circuit_breaker")) storage.setSetting("enable_drawdown_circuit_breaker", "false");
  if (!storage.getSetting("circuit_breaker")) storage.setSetting("circuit_breaker", "ok");
  if (!storage.getSetting("multi_source_verify")) storage.setSetting("multi_source_verify", "true");
  if (!storage.getSetting("polling_interval")) storage.setSetting("polling_interval", "5");
  if (!storage.getSetting("max_daily_trades")) storage.setSetting("max_daily_trades", "0");
  if (!storage.getSetting("max_order_size")) storage.setSetting("max_order_size", "100");
  if (storage.getSetting("max_order_size") === "25") storage.setSetting("max_order_size", "100");
  if (!storage.getSetting("max_risk_per_trade")) storage.setSetting("max_risk_per_trade", "0.08");
  if (!storage.getSetting("use_percent_sizing")) storage.setSetting("use_percent_sizing", "true");
  if (!storage.getSetting("enable_dynamic_sizing")) storage.setSetting("enable_dynamic_sizing", "false");
  if (!storage.getSetting("base_position_pct")) storage.setSetting("base_position_pct", "0.02");
  if (!storage.getSetting("max_position_pct")) storage.setSetting("max_position_pct", "0.05");
  if (!storage.getSetting("loss_streak_reduce_pct")) storage.setSetting("loss_streak_reduce_pct", "0.20");
  if (!storage.getSetting("win_streak_increase_pct")) storage.setSetting("win_streak_increase_pct", "0.10");
  if (!storage.getSetting("enable_multi_asset_markets")) storage.setSetting("enable_multi_asset_markets", "false");
  if (!storage.getSetting("enable_orderbook_optimizer")) storage.setSetting("enable_orderbook_optimizer", "true");
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
  const processedTradeIds = new Set<number>();
  const arbGroups = new Map<string, TradeLog[]>();

  for (const trade of openTrades) {
    if (trade.strategyName !== "Pure YES/NO Arbitrage" || !trade.tradeGroupId) continue;
    const legs = arbGroups.get(trade.tradeGroupId) ?? [];
    legs.push(trade);
    arbGroups.set(trade.tradeGroupId, legs);
  }

  for (const [tradeGroupId, legs] of arbGroups) {
    const first = legs[0];
    if (!first.marketId) continue;

    try {
      const market = await fetchMarketById(first.marketId);
      if (!isResolvedMarket(market)) continue;

      let groupNetPnl = 0;
      let groupSize = 0;
      const closedAt = new Date().toISOString();

      for (const leg of legs) {
        const resolutionPrice = getResolutionPriceForOutcome(
          market,
          leg.outcome === "YES" ? "YES" : "NO",
        );
        if (resolutionPrice == null) continue;

        const entryPrice = clampProbability(leg.price);
        const shares = leg.size / entryPrice;
        const payout = shares * resolutionPrice;
        const grossPnl = payout - leg.size;
        const entryFee = leg.feePaid ?? calculateTakerFee(leg.size, entryPrice, feeRate);
        const netPnl = grossPnl - entryFee;
        const pnlPercent = leg.size > 0 ? (netPnl / leg.size) * 100 : 0;

        groupNetPnl += netPnl;
        groupSize += leg.size;
        processedTradeIds.add(leg.id);

        storage.updateTradeLog(leg.id, {
          status: "closed",
          exitPrice: resolutionPrice,
          pnl: grossPnl,
          pnlPercent,
          feePaid: entryFee,
          netPnl,
          errorMessage: `Paired arb settled as group ${tradeGroupId}`,
          closedAt,
        });
      }

      if (groupSize <= 0) continue;
      storage.updateStrategyPnl(first.strategyId ?? 0, groupNetPnl, groupNetPnl > 0);
      const currentBalance = parseFloat(storage.getSetting("paper_balance") || "1000");
      storage.setSetting("paper_balance", String(currentBalance + groupNetPnl));
      maybeTriggerDrawdownCircuitBreaker();
    } catch {
      continue;
    }
  }

  for (const trade of openTrades) {
    if (processedTradeIds.has(trade.id)) continue;
    if (trade.strategyName === "Pure YES/NO Arbitrage" && trade.tradeGroupId) continue;
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

      maybeTriggerDrawdownCircuitBreaker();
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
    const { minImbalance, targetImbalance, targetMaxEntry, hardMaxEntry } = getOrderbookRangeConfig(strategy);
    if (imbalance >= minImbalance && yesPrice <= hardMaxEntry) {
      const softPenalty = Math.max(0, targetImbalance - Math.abs(imbalance)) * 0.9
        + Math.max(0, yesPrice - targetMaxEntry) * 1.2;
      return {
        side: "YES" as const,
        score: Math.abs(imbalance) * 1.6 + Math.max(0, targetMaxEntry - yesPrice) * 4 - softPenalty,
        reason: `YES bid imbalance ${imbalance.toFixed(2)} with ${(yesPrice * 100).toFixed(1)}% entry`,
      };
    }
    if (imbalance <= -minImbalance && noPrice <= hardMaxEntry) {
      const softPenalty = Math.max(0, targetImbalance - Math.abs(imbalance)) * 0.9
        + Math.max(0, noPrice - targetMaxEntry) * 1.2;
      return {
        side: "NO" as const,
        score: Math.abs(imbalance) * 1.6 + Math.max(0, targetMaxEntry - noPrice) * 4 - softPenalty,
        reason: `NO bid imbalance ${imbalance.toFixed(2)} with ${(noPrice * 100).toFixed(1)}% entry`,
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

function evaluateAgentOpinion(
  strategy: Strategy,
  market: PolyMarket,
  snapshot: PriceSnapshot,
  candles: any[],
) {
  const config = parseStrategyConfig(strategy);
  const yesPrice = clampProbability(snapshot.yesMid);
  const noPrice = clampProbability(snapshot.noMid, 1 - yesPrice);
  const timeLeftMs = market.endDate ? new Date(market.endDate).getTime() - Date.now() : 0;
  const secondsLeft = Math.max(0, Math.floor(timeLeftMs / 1000));
  const minSecondsLeft = Number(config.minSecondsLeft ?? 30);
  if (secondsLeft < minSecondsLeft) return null;

  const window = candles.slice(-8);
  const firstClose = window[0]?.close ?? null;
  const lastClose = window[window.length - 1]?.close ?? null;
  const spotDelta = firstClose && lastClose ? (lastClose - firstClose) / firstClose : 0;
  const greenRatio = window.length > 0
    ? window.filter((c: any) => c.close > c.open).length / window.length
    : 0.5;
  const yesBidDepth = sumBookSize(snapshot.yesBook?.bids);
  const noBidDepth = sumBookSize(snapshot.noBook?.bids);
  const totalDepth = yesBidDepth + noBidDepth;
  const imbalance = totalDepth > 0 ? (yesBidDepth - noBidDepth) / totalDepth : 0;

  let side: "YES" | "NO" = "YES";
  let directionalConfidence = 0.5;
  let thesis = "neutral market read";

  if (strategy.name === "Orderbook Arbitrage & Imbalance") {
    const { minImbalance } = getOrderbookRangeConfig(strategy);
    if (Math.abs(imbalance) < minImbalance) return null;
    side = imbalance >= 0 ? "YES" : "NO";
    directionalConfidence = 0.5 + Math.min(0.32, Math.abs(imbalance) * 0.55);
    thesis = `${side} book pressure ${imbalance.toFixed(2)}`;
  } else if (strategy.name === "Oracle Lead Arbitrage") {
    side = spotDelta >= 0 ? "YES" : "NO";
    directionalConfidence = 0.5 + Math.min(0.30, Math.abs(spotDelta) * 95);
    thesis = `${side} spot delta ${(spotDelta * 100).toFixed(2)}%`;
  } else if (strategy.name === "Last-Second Momentum Snipe") {
    side = greenRatio >= 0.5 ? "YES" : "NO";
    directionalConfidence = 0.5 + Math.min(0.24, Math.abs(greenRatio - 0.5) * 0.8 + Math.abs(spotDelta) * 45);
    thesis = `${side} momentum green ratio ${greenRatio.toFixed(2)}`;
  } else if (strategy.name === "Spot Correlation Reversion Scalp") {
    const lows = window.map((c: any) => c.low ?? c.close).filter((value: number) => Number.isFinite(value));
    const windowLow = lows.length > 0 ? Math.min(...lows) : lastClose;
    const rebound = windowLow && lastClose ? (lastClose - windowLow) / windowLow : 0;
    side = rebound >= 0.001 || spotDelta >= 0 ? "YES" : "NO";
    directionalConfidence = 0.5 + Math.min(0.24, Math.abs(rebound) * 80 + Math.abs(spotDelta) * 50);
    thesis = `${side} rebound ${(rebound * 100).toFixed(2)}%`;
  }

  const entryPrice = side === "YES" ? yesPrice : noPrice;
  const maxAgentEntryPrice = strategy.name === "Orderbook Arbitrage & Imbalance"
    ? getOrderbookRangeConfig(strategy).hardMaxEntry
    : Number(config.maxAgentEntryPrice ?? config.maxEntryPrice ?? 0.68);
  if (entryPrice > maxAgentEntryPrice) return null;

  const feeRate = parseFloat(storage.getSetting("taker_fee_rate") || "0.072");
  const expectedGrossEdge = directionalConfidence - entryPrice;
  const estimatedEntryFeeDrag = feeRate * (1 - entryPrice);
  const estimatedExitPrice = clampProbability(directionalConfidence);
  const estimatedExitFeeDrag = feeRate * estimatedExitPrice * (1 - estimatedExitPrice) / entryPrice;
  const estimatedFeeDrag = estimatedEntryFeeDrag + estimatedExitFeeDrag;
  const riskPenalty = entryPrice > 0.78 ? (entryPrice - 0.78) * 0.8 : 0;
  const orderbookRangePenalty = strategy.name === "Orderbook Arbitrage & Imbalance"
    ? (() => {
        const { targetImbalance, targetMaxEntry } = getOrderbookRangeConfig(strategy);
        return Math.max(0, targetImbalance - Math.abs(imbalance)) * 0.35
          + Math.max(0, entryPrice - targetMaxEntry) * 0.45;
      })()
    : 0;
  const score = expectedGrossEdge - estimatedFeeDrag - riskPenalty - orderbookRangePenalty;
  const minAgentScore = Number(config.minAgentScore ?? 0.015);

  if (score < minAgentScore) {
    return null;
  }

  return {
    side,
    score,
    reason: `${thesis}; confidence ${(directionalConfidence * 100).toFixed(1)}% vs ${(entryPrice * 100).toFixed(1)}% price; edge ${(score * 100).toFixed(1)}% after round-trip fees`,
  };
}

async function runEngineOnce() {
  ensurePaperDefaults();
  maybeRollDayStartBalance();
  await settleResolvedTrades();
  engineState.lastPollAt = new Date().toISOString();
  engineState.openTrades = storage.getOpenTrades().length;

  if (drawdownStopsEnabled() && storage.getSetting("circuit_breaker") === "triggered") {
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
    engineState.currentMarketRawQuestion = null;
    engineState.currentMarketEndsAt = null;
    engineState.currentMarketTimeLeftSec = null;
    engineState.currentYesPrice = null;
    engineState.currentNoPrice = null;
    engineState.lastPollOutcome = "waiting_for_current_btc_market";
    return;
  }

  const snapshot = await getPriceSnapshot(market);
  const candles = await fetchRecentCryptoCandles(getMarketAssetSymbol(market), 15).catch(() => []);
  const management = manageOpenTradesForCurrentMarket(market, snapshot, strategies);
  engineState.currentMarketId = market.id;
  engineState.currentConditionId = market.conditionId;
  engineState.currentMarketRawQuestion = getMarketTitle(market);
  engineState.currentMarketQuestion = formatTitleWithCurrentEtDate(getMarketTitle(market));
  engineState.currentMarketEndsAt = market.endDate || null;
  engineState.currentMarketTimeLeftSec = getMarketWindowTimeLeftSec(market);
  engineState.currentYesPrice = snapshot.yesMid;
  engineState.currentNoPrice = snapshot.noMid;
  engineState.openTrades = storage.getOpenTrades().length;
  const maxDailyTrades = Math.max(0, parseInt(storage.getSetting("max_daily_trades") || "0", 10));
  const maxOrderSize = parseFloat(storage.getSetting("max_order_size") || "25");
  let tradesToday = countTradesToday();
  let openExposure = getOpenExposure();
  let openedTrade = false;
  let lastSkipReason = management.summary ? `managed_open_trades: ${management.summary}` : "scanned_no_signal";

  if (management.closed.length > 0) {
    const latest = management.closed[management.closed.length - 1];
    engineState.lastSignalAt = new Date().toISOString();
    engineState.lastSignalStrategy = latest.strategyName;
    engineState.lastSignalReason = `Exited ${latest.strategyName} via ${latest.exitReason} (${(latest.netPnl >= 0 ? "+" : "")}${latest.netPnl.toFixed(2)} USDC)`;
  }
  const recommendations: Array<{
    strategy: Strategy;
    diagnostic: NonNullable<EngineRuntimeState["strategyDiagnostics"]>[number] | undefined;
    signal: TradeSignal;
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
        const cooldownMs = getStrategyCooldownMs(strategy);
        if (Date.now() - new Date(strategy.lastTriggered).getTime() < cooldownMs) {
          lastSkipReason = `${strategy.name}: cooldown_active`;
        if (diagnostic) {
          diagnostic.outcome = "cooldown";
          diagnostic.detail = `Waiting for cooldown to expire (${Math.ceil(cooldownMs / 1000)}s)`;
          diagnostic.score = null;
        }
        continue;
      }
      }

      const config = parseStrategyConfig(strategy);
      const balance = parseFloat(storage.getSetting("paper_balance") || "1000");
      const sizing = calculateStrategySizing(strategy, config, balance, maxOrderSize);
      const orderSize = sizing.orderSize;
      if (maxDailyTrades > 0 && tradesToday >= maxDailyTrades) {
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
      if (diagnostic) {
        diagnostic.detail = sizing.detail;
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

      const pureArbSignal = strategy.name === "Pure YES/NO Arbitrage"
        ? evaluatePureArbitrage(strategy, market, snapshot, orderSize)
        : null;
      const optimization = strategy.name === "Pure YES/NO Arbitrage"
        ? { strategy, profileName: "paired", signal: pureArbSignal, scanned: 1, bestRejectedStrategy: strategy }
        : await optimizeOrderbookStrategy(strategy, market, snapshot, candles);
      const evaluationStrategy = optimization.strategy;
      const signal = optimization.signal;
      if (!signal) {
        lastSkipReason = `${strategy.name}: no_signal`;
        if (diagnostic) {
          diagnostic.outcome = "no_signal";
          diagnostic.detail = strategy.name === "Orderbook Arbitrage & Imbalance"
            ? `Optimizer scanned ${optimization.scanned} profiles; ${describeOrderbookState(optimization.bestRejectedStrategy, snapshot)}`
            : strategy.name === "Pure YES/NO Arbitrage"
              ? describePureArbState(strategy, snapshot, orderSize)
              : "Agent did not find positive edge after fees";
          diagnostic.score = null;
        }
        continue;
      }

      if (diagnostic) {
        diagnostic.outcome = "recommended";
        diagnostic.detail = strategy.name === "Pure YES/NO Arbitrage"
          ? signal.reason
          : strategy.name === "Orderbook Arbitrage & Imbalance"
          ? `Optimizer selected ${optimization.profileName}: ${signal.reason}`
          : signal.reason;
        diagnostic.score = Number(signal.score.toFixed(3));
      }
      recommendations.push({ strategy: evaluationStrategy, diagnostic, signal, orderSize });
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
  const winnerConfig = parseStrategyConfig(winner.strategy);
  const managerScoreThreshold = winner.strategy.name === "Orderbook Arbitrage & Imbalance"
    ? Number(winnerConfig.managerScoreThreshold ?? winnerConfig.minAgentScore ?? 0.006)
    : winner.strategy.name === "Pure YES/NO Arbitrage"
      ? Number(winnerConfig.minNetEdgePct ?? 0.005)
    : 0.015;
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
      if (winner.strategy.name === "Pure YES/NO Arbitrage" && !winner.signal.arb) {
        lastSkipReason = `${winner.strategy.name}: invalid_unpaired_signal`;
        if (diagnostic) {
          diagnostic.outcome = "bad_signal";
          diagnostic.detail = "Pure arbitrage refused an unpaired directional signal";
          diagnostic.score = Number(winner.signal.score.toFixed(3));
        }
        engineState.lastPollOutcome = lastSkipReason;
        return;
      }

      if (winner.signal.arb) {
        const arb = winner.signal.arb;
        if (!snapshot.yesTokenId || !snapshot.noTokenId) {
          lastSkipReason = `${winner.strategy.name}: invalid_arb_snapshot`;
          if (diagnostic) {
            diagnostic.outcome = "bad_snapshot";
            diagnostic.detail = "Missing YES or NO token for paired arbitrage entry";
            diagnostic.score = Number(winner.signal.score.toFixed(3));
          }
          engineState.lastPollOutcome = lastSkipReason;
          return;
        }

        const yesFee = calculateTakerFee(arb.yesSize, arb.yesPrice, parseFloat(storage.getSetting("taker_fee_rate") || "0.072"));
        const noFee = calculateTakerFee(arb.noSize, arb.noPrice, parseFloat(storage.getSetting("taker_fee_rate") || "0.072"));
        const timestamp = new Date().toISOString();
        const marketQuestion = market._eventTitle || market.question || winner.strategy.marketQuestion;
        const tradeGroupId = `arb-${market.conditionId || market.id}-${Date.now()}`;
        storage.createTradeLog({
          strategyId: winner.strategy.id,
          strategyName: winner.strategy.name,
          marketId: market.id,
          conditionId: market.conditionId,
          tokenId: snapshot.yesTokenId,
          side: "BUY",
          outcome: "YES",
          tradeGroupId,
          price: arb.yesPrice,
          size: arb.yesSize,
          status: "open",
          timestamp,
          marketQuestion,
          feePaid: yesFee,
          errorMessage: `Paired arb YES leg: ${winner.signal.reason}`,
        });
        storage.createTradeLog({
          strategyId: winner.strategy.id,
          strategyName: winner.strategy.name,
          marketId: market.id,
          conditionId: market.conditionId,
          tokenId: snapshot.noTokenId,
          side: "BUY",
          outcome: "NO",
          tradeGroupId,
          price: arb.noPrice,
          size: arb.noSize,
          status: "open",
          timestamp,
          marketQuestion,
          feePaid: noFee,
          errorMessage: `Paired arb NO leg: ${winner.signal.reason}`,
        });

        storage.markStrategyTriggered(winner.strategy.id);
        tradesToday += 1;
        openExposure += arb.totalCost;
        openedTrade = true;
        engineState.lastSignalAt = timestamp;
        engineState.lastSignalStrategy = winner.strategy.name;
        engineState.lastSignalReason = `Manager selected paired arb: ${winner.signal.reason}`;
        engineState.openTrades = storage.getOpenTrades().length;
        if (diagnostic) {
          diagnostic.outcome = "entered";
          diagnostic.detail = `Manager entered paired arb: ${winner.signal.reason}`;
          diagnostic.score = Number(winner.signal.score.toFixed(3));
        }
        engineState.lastPollOutcome = "opened_paper_trade";
        return;
      }

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
      if (winner.strategy.name === "Orderbook Arbitrage & Imbalance" && storage.getSetting("enable_orderbook_optimizer") !== "false") {
        storage.updateStrategy(winner.strategy.id, {
          config: winner.strategy.config,
        });
      }
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
    storage.setSetting("day_balance_reset", getTodayKey());
    storage.setSetting("circuit_breaker", "ok");
    storage.setSetting("circuit_breaker_at", "");
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
    const drawdownCircuitBreakerEnabled = drawdownStopsEnabled();
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
      drawdownCircuitBreakerEnabled,
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
        const prior = recent.slice(0, -1);
        const start = recent[recent.length - 1].close;
        const end = future[future.length - 1].close;
        const priorStart = prior[0]?.close ?? start;
        const recentDelta = priorStart > 0 ? (start - priorStart) / priorStart : 0;
        const priorClose = prior[prior.length - 1]?.close ?? start;
        const lastMove = priorClose > 0 ? (start - priorClose) / priorClose : 0;
        const simulatedYesPrice = clampProbability(0.5 + recentDelta * 8 + lastMove * 12);
        const simulatedNoPrice = clampProbability(1 - simulatedYesPrice);

        let side: "YES" | "NO" | null = null;
        if (strategyName === "Last-Second Momentum Snipe") {
          const greenRatio = recent.filter((c: any) => c.close > c.open).length / recent.length;
          if (greenRatio >= 0.6 && simulatedYesPrice <= 0.48) side = "YES";
        } else if (strategyName === "Orderbook Arbitrage & Imbalance") {
          if (Math.abs(recentDelta) >= 0.0015) side = recentDelta >= 0 ? "YES" : "NO";
        } else if (strategyName === "Spot Correlation Reversion Scalp") {
          const low = Math.min(...recent.map((c: any) => c.low ?? c.close));
          const rebound = low > 0 ? (recent[recent.length - 1].close - low) / low : 0;
          if (rebound >= 0.0025 && simulatedYesPrice <= 0.46) side = "YES";
        } else if (strategyName === "Oracle Lead Arbitrage") {
          if (Math.abs(lastMove) >= 0.002) side = lastMove >= 0 ? "YES" : "NO";
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

  app.delete("/api/backtest", (_req, res) => {
    storage.clearBacktestRuns();
    res.json({ ok: true });
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
      currentMarketRawQuestion: engineState.currentMarketRawQuestion,
      currentMarketEndsAt: engineState.currentMarketEndsAt,
      currentMarketTimeLeftSec: engineState.currentMarketTimeLeftSec,
      currentYesPrice: engineState.currentYesPrice,
      currentNoPrice: engineState.currentNoPrice,
      strategyDiagnostics: engineState.strategyDiagnostics,
      managerDecision: engineState.managerDecision,
      marketDebug: engineState.marketDebug,
    });
  });

  return httpServer;
}
