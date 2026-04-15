import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { insertStrategySchema, insertWatchlistSchema } from "@shared/schema";

const GAMMA_API = "https://gamma-api.polymarket.com";
const CLOB_API = "https://clob.polymarket.com";

// Proxy fetch to Polymarket APIs
async function polyFetch(baseUrl: string, path: string, params?: Record<string, string>) {
  const url = new URL(path, baseUrl);
  if (params) {
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  }
  const res = await fetch(url.toString(), {
    headers: { "Accept": "application/json" },
  });
  if (!res.ok) {
    throw new Error(`Polymarket API error: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

// The 4 fixed strategies — seeded once on startup if not present
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
    config: JSON.stringify({ mainSize: 0.8, hedgeSize: 0.2, tpPct: 0.03, slPct: 0.015, description: "WS detects Up <0.48 amid upward spot momentum. Buy 80% main, hedge 20% opposite. Exit +2-4% or SL -1.5%." }),
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
    config: JSON.stringify({ mainSize: 1.0, hedgeSize: 0, tpPct: 0, slPct: 0, description: "Bid/ask skew or L2 imbalance detected. Proportional buys or snipe the skew. 80-90% win rate in thin liquidity." }),
  },
  {
    name: "Spot Correlation Reversion Scalp",
    marketQuestion: "Bitcoin Up or Down - 5 Minutes (auto-roll)",
    side: "YES" as const,
    triggerType: "price_below",
    triggerPrice: 0.45,
    orderSize: 10,
    orderType: "LIMIT",
    cooldownMinutes: 1,
    isActive: false,
    autoRoll: true,
    config: JSON.stringify({ mainSize: 0.875, hedgeSize: 0.125, tpPct: 0.025, slPct: 0, spotReboundPct: 0.003, windowSecs: 30, description: "Polymarket Up at 45% while spot rebounds >0.3% in 30s. Buy undervalued token, light hedge 10-15%. Exit +2.5% or RSI signal." }),
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
    config: JSON.stringify({ mainSize: 0.7, hedgeSize: 0.3, tpPct: 0.02, slPct: 0, cexDeltaPct: 0.002, description: "CEX or Chainlink feed shows >0.2% delta while Polymarket lags. Buy mispriced token (70%), hedge (30%). Exit +1.5-3% or pre-resolution." }),
  },
];

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  // Seed fixed strategies and default settings
  storage.upsertStrategies(FIXED_STRATEGIES as any);
  if (!storage.getSetting("paper_balance")) storage.setSetting("paper_balance", "1000");
  if (!storage.getSetting("day_start_balance")) storage.setSetting("day_start_balance", "1000");
  if (!storage.getSetting("taker_fee_rate")) storage.setSetting("taker_fee_rate", "0.01");
  if (!storage.getSetting("drawdown_limit")) storage.setSetting("drawdown_limit", "0.10");
  if (!storage.getSetting("circuit_breaker")) storage.setSetting("circuit_breaker", "ok");
  if (!storage.getSetting("multi_source_verify")) storage.setSetting("multi_source_verify", "true");

  // ===== MARKET DATA (proxied from Polymarket) =====

  // Search/list markets
  // The Gamma API title filter is broken — it ignores the param.
  // We fetch a large batch sorted by startDate (newest first, catches rolling
  // crypto candle markets) and filter client-side for search queries.
  app.get("/api/markets", async (req, res) => {
    try {
      const search = req.query.search as string | undefined;
      const showClosed = req.query.closed === "true";
      const tag = req.query.tag as string | undefined;

      const baseParams: Record<string, string> = {
        limit: "100",
        offset: "0",
      };
      if (tag) baseParams.tag = tag;

      if (showClosed) {
        // Results tab: closed markets sorted by end date
        baseParams.active = "false";
        baseParams.closed = "true";
        baseParams.order = "endDate";
        baseParams.ascending = "false";
        const closedEvents = await polyFetch(GAMMA_API, "/events", baseParams) as any[];
        const allMarkets: any[] = [];
        for (const event of (Array.isArray(closedEvents) ? closedEvents : [])) {
          const eventMarkets: any[] = event.markets || [];
          if (eventMarkets.length > 0) {
            for (const m of eventMarkets) allMarkets.push({ ...m, _eventTitle: event.title, _eventImage: event.image });
          } else {
            allMarkets.push({ id: event.id, question: event.title, conditionId: "", outcomePrices: null, outcomes: null, clobTokenIds: null, volumeNum: parseFloat(event.volume || "0"), endDate: event.endDate, image: event.image });
          }
        }
        const filtered = search ? allMarkets.filter((m: any) => m.question?.toLowerCase().includes(search.toLowerCase()) || m._eventTitle?.toLowerCase().includes(search.toLowerCase())) : allMarkets;
        res.json(filtered);
        return;
      }

      // Live tab: Fetch two batches in parallel:
      //   1. Newest events (catches 5-min crypto candles)
      //   2. Highest volume events (catches big prediction markets)
      const nowIso = new Date().toISOString();
      const [newestEvents, topEvents] = await Promise.all([
        polyFetch(GAMMA_API, "/events", {
          ...baseParams,
          active: "true",
          closed: "false",
          end_date_min: nowIso,
          order: "startDate",
          ascending: "false",
        }) as Promise<any[]>,
        polyFetch(GAMMA_API, "/events", {
          ...baseParams,
          active: "true",
          closed: "false",
          end_date_min: nowIso,
          order: "volume",
          ascending: "false",
        }) as Promise<any[]>,
      ]);

      // Merge and deduplicate by event id
      const seen = new Set<string>();
      const allEvents: any[] = [];
      for (const e of [...(Array.isArray(newestEvents) ? newestEvents : []), ...(Array.isArray(topEvents) ? topEvents : [])]) {
        if (!seen.has(e.id)) {
          seen.add(e.id);
          allEvents.push(e);
        }
      }

      // Flatten events -> individual markets
      const allMarkets: any[] = [];
      for (const event of allEvents) {
        const eventMarkets: any[] = event.markets || [];
        if (eventMarkets.length > 0) {
          for (const m of eventMarkets) {
            allMarkets.push({ ...m, _eventTitle: event.title, _eventImage: event.image });
          }
        } else {
          // Event with no nested markets — use event itself
          allMarkets.push({
            id: event.id,
            question: event.title,
            conditionId: "",
            outcomePrices: null,
            outcomes: null,
            clobTokenIds: null,
            volumeNum: parseFloat(event.volume || "0"),
            endDate: event.endDate,
            image: event.image,
          });
        }
      }

      // Drop any markets whose endDate is already in the past (API sometimes returns stale ones)
      const nowMs = Date.now();
      const liveMarkets = allMarkets.filter((m: any) => {
        if (!m.endDate) return true;
        return new Date(m.endDate).getTime() > nowMs;
      });

      if (search) {
        const term = search.toLowerCase();
        const filtered = liveMarkets.filter((m: any) =>
          m.question?.toLowerCase().includes(term) ||
          m._eventTitle?.toLowerCase().includes(term)
        );
        res.json(filtered);
        return;
      }

      res.json(liveMarkets);
    } catch (e: any) {
      res.status(502).json({ error: e.message });
    }
  });

  // Get current live BTC 5-min candle market (always returns the one that's active right now)
  app.get("/api/markets/btc-candle/current", async (req, res) => {
    try {
      // Fetch newest active events and find the current BTC 5-min candle
      const events = await polyFetch(GAMMA_API, "/events", {
        limit: "50",
        offset: "0",
        active: "true",
        closed: "false",
        order: "startDate",
        ascending: "false",
      }) as any[];

      const now = Date.now();
      let bestMatch: any = null;

      for (const event of (Array.isArray(events) ? events : [])) {
        const title: string = (event.title || "").toLowerCase();
        if (
          title.includes("bitcoin") &&
          (title.includes("up or down") || title.includes("up/down")) &&
          title.includes("minute")
        ) {
          // Pick the one whose end date is soonest but still in the future
          const endMs = event.endDate ? new Date(event.endDate).getTime() : Infinity;
          if (endMs > now) {
            if (
              !bestMatch ||
              endMs < new Date(bestMatch.endDate).getTime()
            ) {
              bestMatch = event;
            }
          }
        }
      }

      if (!bestMatch) {
        res.status(404).json({ error: "No active BTC 5-min candle market found" });
        return;
      }

      // Flatten to market
      const markets: any[] = bestMatch.markets || [];
      if (markets.length > 0) {
        res.json({ event: bestMatch, market: { ...markets[0], _eventTitle: bestMatch.title, _eventImage: bestMatch.image } });
      } else {
        res.json({ event: bestMatch, market: null });
      }
    } catch (e: any) {
      res.status(502).json({ error: e.message });
    }
  });

  // Get single market
  app.get("/api/markets/:id", async (req, res) => {
    try {
      const data = await polyFetch(GAMMA_API, `/markets/${req.params.id}`);
      res.json(data);
    } catch (e: any) {
      res.status(502).json({ error: e.message });
    }
  });

  // Get events
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

  // Get tags/categories
  app.get("/api/tags", async (_req, res) => {
    try {
      const data = await polyFetch(GAMMA_API, "/tags");
      res.json(data);
    } catch (e: any) {
      res.status(502).json({ error: e.message });
    }
  });

  // Get orderbook for a token
  app.get("/api/orderbook/:tokenId", async (req, res) => {
    try {
      const data = await polyFetch(CLOB_API, "/book", {
        token_id: req.params.tokenId,
      });
      res.json(data);
    } catch (e: any) {
      res.status(502).json({ error: e.message });
    }
  });

  // Get price for a token
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

  // Get midpoint for a token
  app.get("/api/midpoint/:tokenId", async (req, res) => {
    try {
      const data = await polyFetch(CLOB_API, "/midpoint", {
        token_id: req.params.tokenId,
      });
      res.json(data);
    } catch (e: any) {
      res.status(502).json({ error: e.message });
    }
  });

  // Get spread for a token
  app.get("/api/spread/:tokenId", async (req, res) => {
    try {
      const data = await polyFetch(CLOB_API, "/spread", {
        token_id: req.params.tokenId,
      });
      res.json(data);
    } catch (e: any) {
      res.status(502).json({ error: e.message });
    }
  });

  // ===== STRATEGIES =====

  app.get("/api/strategies", async (_req, res) => {
    const strats = storage.getStrategies();
    res.json(strats);
  });

  app.get("/api/strategies/:id", async (req, res) => {
    const s = storage.getStrategy(parseInt(req.params.id));
    if (!s) return res.status(404).json({ error: "Strategy not found" });
    res.json(s);
  });

  app.post("/api/strategies", async (req, res) => {
    try {
      const parsed = insertStrategySchema.parse(req.body);
      const s = storage.createStrategy(parsed);
      res.json(s);
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  app.patch("/api/strategies/:id", async (req, res) => {
    const s = storage.updateStrategy(parseInt(req.params.id), req.body);
    if (!s) return res.status(404).json({ error: "Strategy not found" });
    res.json(s);
  });

  app.delete("/api/strategies/:id", async (req, res) => {
    storage.deleteStrategy(parseInt(req.params.id));
    res.json({ success: true });
  });

  app.post("/api/strategies/:id/toggle", async (req, res) => {
    const { isActive } = req.body;
    const s = storage.toggleStrategy(parseInt(req.params.id), isActive);
    if (!s) return res.status(404).json({ error: "Strategy not found" });
    res.json(s);
  });

  // ===== TRADE LOGS =====

  app.get("/api/trades", async (req, res) => {
    const limit = parseInt((req.query.limit as string) || "100");
    const logs = storage.getTradeLogs(limit);
    res.json(logs);
  });

  app.get("/api/trades/strategy/:id", async (req, res) => {
    const logs = storage.getTradeLogsByStrategy(parseInt(req.params.id));
    res.json(logs);
  });

  // Simulate a strategy trigger (for testing without real wallet)
  app.post("/api/strategies/:id/simulate", async (req, res) => {
    const strategy = storage.getStrategy(parseInt(req.params.id));
    if (!strategy) return res.status(404).json({ error: "Strategy not found" });

    try {
      // Get current price from CLOB
      let currentPrice = 0.5;
      if (strategy.tokenId) {
        try {
          const priceData = await polyFetch(CLOB_API, "/midpoint", {
            token_id: strategy.tokenId,
          });
          currentPrice = parseFloat(priceData.mid || "0.5");
        } catch { /* use default */ }
      }

      // Check if trigger condition is met
      let triggered = false;
      if (strategy.triggerType === "price_below" && currentPrice < strategy.triggerPrice) {
        triggered = true;
      } else if (strategy.triggerType === "price_above" && currentPrice > strategy.triggerPrice) {
        triggered = true;
      }

      const tradeLog = storage.createTradeLog({
        strategyId: strategy.id,
        tokenId: strategy.tokenId || "unknown",
        side: "BUY",
        outcome: strategy.side,
        price: currentPrice,
        size: strategy.orderSize,
        status: triggered ? "simulated" : "not_triggered",
        timestamp: new Date().toISOString(),
        marketQuestion: strategy.marketQuestion,
      });

      if (triggered) {
        storage.markStrategyTriggered(strategy.id);
      }

      res.json({ triggered, currentPrice, triggerPrice: strategy.triggerPrice, tradeLog });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ===== WATCHLIST =====

  app.get("/api/watchlist", async (_req, res) => {
    const items = storage.getWatchlist();
    res.json(items);
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
    storage.removeFromWatchlist(parseInt(req.params.id));
    res.json({ success: true });
  });

  // ===== BOT SETTINGS =====

  app.get("/api/settings", async (_req, res) => {
    const settings = storage.getAllSettings();
    res.json(settings);
  });

  app.post("/api/settings", async (req, res) => {
    const { key, value } = req.body;
    if (!key || value === undefined) return res.status(400).json({ error: "key and value required" });
    storage.setSetting(key, value);
    res.json({ success: true });
  });

  // ===== PAPER BALANCE =====

  app.get("/api/paper-balance", (_req, res) => {
    const balance = parseFloat(storage.getSetting("paper_balance") || "1000");
    res.json({ balance });
  });

  app.post("/api/paper-balance", (req, res) => {
    const { balance } = req.body;
    if (typeof balance !== "number") return res.status(400).json({ error: "balance must be a number" });
    storage.setSetting("paper_balance", String(balance));
    res.json({ balance });
  });

  // ===== P&L =====

  app.get("/api/pnl", (_req, res) => {
    const strats = storage.getStrategies();
    const logs = storage.getTradeLogs(1000);
    const totalPnl = strats.reduce((sum, s) => sum + (s.totalPnl ?? 0), 0);
    const totalWins = strats.reduce((sum, s) => sum + (s.winCount ?? 0), 0);
    const totalLosses = strats.reduce((sum, s) => sum + (s.lossCount ?? 0), 0);
    const paperBalance = parseFloat(storage.getSetting("paper_balance") || "1000");
    const perStrategy = strats.map((s) => ({
      id: s.id,
      name: s.name,
      totalPnl: s.totalPnl ?? 0,
      winCount: s.winCount ?? 0,
      lossCount: s.lossCount ?? 0,
      totalExecutions: s.totalExecutions,
      winRate: s.winCount + s.lossCount > 0
        ? ((s.winCount ?? 0) / (s.winCount + s.lossCount) * 100).toFixed(1)
        : null,
    }));
    res.json({ totalPnl, totalWins, totalLosses, paperBalance, perStrategy });
  });

  // Manually close a trade with P&L (fees applied)
  app.post("/api/trades/:id/close", (req, res) => {
    const { exitPrice } = req.body;
    const trade = storage.getTradeLogs(1000).find((t) => t.id === parseInt(req.params.id));
    if (!trade) return res.status(404).json({ error: "Trade not found" });
    const ep = parseFloat(exitPrice);
    const entryPrice = trade.price;
    const size = trade.size;
    const feeRate = parseFloat(storage.getSetting("taker_fee_rate") || "0.01"); // default 1%
    const grossPnl = (ep - entryPrice) * size;
    const feePaid = size * feeRate * 2; // fee on entry + exit
    const netPnl = grossPnl - feePaid;
    const pnlPercent = (grossPnl / (entryPrice * size)) * 100;
    const won = netPnl > 0;
    storage.updateTradeLog(trade.id, {
      exitPrice: ep, pnl: grossPnl, pnlPercent,
      closedAt: new Date().toISOString(), status: "closed",
      feePaid, netPnl,
    });
    if (trade.strategyId) storage.updateStrategyPnl(trade.strategyId, netPnl, won);
    // Check daily drawdown circuit breaker before updating balance
    const balance = parseFloat(storage.getSetting("paper_balance") || "1000");
    const startOfDayBalance = parseFloat(storage.getSetting("day_start_balance") || String(balance));
    const drawdownLimit = parseFloat(storage.getSetting("drawdown_limit") || "0.10");
    const newBalance = balance + netPnl;
    const drawdownPct = (startOfDayBalance - newBalance) / startOfDayBalance;
    if (drawdownPct >= drawdownLimit) {
      storage.setSetting("circuit_breaker", "triggered");
      storage.setSetting("circuit_breaker_at", new Date().toISOString());
    }
    storage.setSetting("paper_balance", String(newBalance));
    res.json({ grossPnl, feePaid, netPnl, pnlPercent, won, circuitBreaker: drawdownPct >= drawdownLimit });
  });

  // ===== SAFEGUARDS =====

  app.get("/api/safeguards", async (_req, res) => {
    const balance = parseFloat(storage.getSetting("paper_balance") || "1000");
    const startOfDayBalance = parseFloat(storage.getSetting("day_start_balance") || "1000");
    const drawdownLimit = parseFloat(storage.getSetting("drawdown_limit") || "0.10");
    const circuitBreaker = storage.getSetting("circuit_breaker") || "ok";
    const circuitBreakerAt = storage.getSetting("circuit_breaker_at") || null;
    const drawdownPct = startOfDayBalance > 0
      ? Math.max(0, (startOfDayBalance - balance) / startOfDayBalance)
      : 0;

    // Latency probe — measure round-trip to Gamma API
    let latencyMs: number | null = null;
    try {
      const t0 = Date.now();
      await fetch("https://gamma-api.polymarket.com/events?limit=1&active=true", { signal: AbortSignal.timeout(3000) });
      latencyMs = Date.now() - t0;
    } catch { /* timeout or network error */ }

    // Lag score — compare Gamma API price vs Chainlink BTC/USD to detect Polymarket lagging
    // Fetch both in parallel
    let lagScore: number | null = null;
    let polyPrice: number | null = null;
    let chainlinkPrice: number | null = null;
    try {
      const [polyRes, clRes] = await Promise.allSettled([
        // Polymarket: get current BTC 5-min candle "Yes" price as implied BTC direction
        fetch("https://gamma-api.polymarket.com/events?limit=5&active=true&closed=false&order=startDate&ascending=false",
          { signal: AbortSignal.timeout(3000) }).then((r) => r.json()),
        // Chainlink BTC/USD feed via public aggregator proxy
        fetch("https://min-api.cryptocompare.com/data/price?fsym=BTC&tsyms=USD",
          { signal: AbortSignal.timeout(3000) }).then((r) => r.json()),
      ]);

      if (clRes.status === "fulfilled" && clRes.value?.USD) {
        chainlinkPrice = clRes.value.USD;
      }
      if (polyRes.status === "fulfilled" && Array.isArray(polyRes.value)) {
        // Find BTC candle event, extract Yes price
        for (const ev of polyRes.value) {
          const title = (ev.title || "").toLowerCase();
          if (title.includes("bitcoin") && title.includes("up or down")) {
            const mkt = ev.markets?.[0];
            if (mkt?.outcomePrices) {
              try {
                const prices = JSON.parse(mkt.outcomePrices);
                polyPrice = parseFloat(prices[0]); // "Yes" = Up probability
              } catch { /* parse fail */ }
            }
            break;
          }
        }
      }

      // Lag score: if chainlinkPrice moved significantly but polyPrice hasn't adjusted
      // We approximate: lagScore = 0 (aligned) to 1 (strongly lagging)
      // For now: flag if polyPrice < 0.45 or > 0.55 (strongly directional) — real lag needs time-series
      if (polyPrice !== null) {
        const deviation = Math.abs(polyPrice - 0.5);
        lagScore = parseFloat((deviation * 2).toFixed(3)); // 0 = neutral, 1 = strongly directional
      }
    } catch { /* non-critical */ }

    res.json({
      drawdownPct: parseFloat((drawdownPct * 100).toFixed(2)),
      drawdownLimit: parseFloat((drawdownLimit * 100).toFixed(0)),
      circuitBreaker,
      circuitBreakerAt,
      latencyMs,
      lagScore,
      polyPrice,
      chainlinkPrice,
    });
  });

  // Reset circuit breaker manually
  app.post("/api/safeguards/reset", (_req, res) => {
    const balance = parseFloat(storage.getSetting("paper_balance") || "1000");
    storage.setSetting("circuit_breaker", "ok");
    storage.setSetting("circuit_breaker_at", "");
    storage.setSetting("day_start_balance", String(balance));
    res.json({ ok: true });
  });

  // ===== BACKTEST =====

  app.post("/api/backtest", async (req, res) => {
    try {
      const { strategyName, periodDays = 7, orderSize = 10 } = req.body;
      const feeRate = parseFloat(storage.getSetting("taker_fee_rate") || "0.01");

      // Fetch Chainlink BTC/USD OHLC from CryptoCompare (free, no key needed)
      // Each data point = 5 minutes; limit = periodDays * 24 * 12
      const limit = Math.min(periodDays * 24 * 12, 2000);
      const ohlcRes = await fetch(
        `https://min-api.cryptocompare.com/data/v2/histominute?fsym=BTC&tsym=USD&limit=${limit}&aggregate=5`,
        { signal: AbortSignal.timeout(10000) }
      );
      if (!ohlcRes.ok) throw new Error("Failed to fetch OHLC data");
      const ohlcData = await ohlcRes.json();
      const candles: { time: number; open: number; high: number; low: number; close: number; volumeto: number }[] =
        ohlcData?.Data?.Data || [];

      if (candles.length < 10) {
        res.status(502).json({ error: "Not enough historical data returned" });
        return;
      }

      // Simulate strategy logic against each 5-min candle
      let wins = 0, losses = 0, grossPnl = 0, totalFees = 0, edges: number[] = [];

      for (let i = 1; i < candles.length; i++) {
        const prev = candles[i - 1];
        const curr = candles[i];
        const priceChange = (curr.close - prev.close) / prev.close; // % move this candle
        let entryProb = 0.5; // simulated Polymarket Yes probability
        let signal = false;
        let betUp = true;

        if (strategyName === "Last-Second Momentum Snipe") {
          // Signal: prev candle was up (momentum), Yes prob < 0.48
          const prevUp = prev.close > prev.open;
          entryProb = prevUp ? 0.44 + Math.random() * 0.06 : 0.5 + Math.random() * 0.08;
          signal = prevUp && entryProb < 0.48;
          betUp = true;
        } else if (strategyName === "Orderbook Arbitrage & Imbalance") {
          // Signal: simulated orderbook imbalance (volume skew proxy)
          const volSkew = curr.volumeto / (prev.volumeto + 1);
          signal = volSkew > 1.3 || volSkew < 0.7;
          betUp = volSkew > 1.3;
          entryProb = betUp ? 0.48 : 0.52;
        } else if (strategyName === "Spot Correlation Reversion Scalp") {
          // Signal: price bounced > 0.3% and Yes prob < 0.45
          const rebound = (curr.close - prev.low) / prev.low;
          entryProb = 0.40 + Math.random() * 0.08;
          signal = rebound > 0.003 && entryProb < 0.45;
          betUp = true;
        } else if (strategyName === "Oracle Lead Arbitrage") {
          // Signal: simulate CEX delta > 0.2% ahead of implied price
          const cexDelta = Math.abs(priceChange);
          signal = cexDelta > 0.002;
          betUp = priceChange > 0;
          entryProb = betUp ? 0.46 : 0.54;
        } else {
          signal = Math.random() > 0.6; // random fallback
          betUp = Math.random() > 0.5;
        }

        if (!signal) continue;

        // Outcome: did BTC actually go up this candle?
        const actuallyUp = curr.close >= prev.close;
        const won = betUp ? actuallyUp : !actuallyUp;

        // P&L calculation
        const edge = won
          ? Math.abs(priceChange) * (1 - entryProb) / entryProb // simplified payoff
          : -entryProb;
        const tradePnl = orderSize * edge;
        const fee = orderSize * feeRate * 2;
        grossPnl += tradePnl;
        totalFees += fee;
        edges.push(tradePnl - fee);
        if (won) wins++; else losses++;
      }

      const totalTrades = wins + losses;
      const winRate = totalTrades > 0 ? wins / totalTrades : 0;
      const netPnl = grossPnl - totalFees;
      const avgEdge = edges.length > 0 ? edges.reduce((a, b) => a + b, 0) / edges.length : 0;
      const edgePct = orderSize > 0 ? (avgEdge / orderSize) * 100 : 0;
      const meetsTarget = winRate >= 0.65 && edgePct >= 3;

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

  // ===== BOT STATUS =====

  app.get("/api/bot/status", async (_req, res) => {
    const strats = storage.getStrategies();
    const activeCount = strats.filter(s => s.isActive).length;
    const logs = storage.getTradeLogs(10);
    const mode = storage.getSetting("mode") || "paper";
    res.json({
      mode,
      activeStrategies: activeCount,
      totalStrategies: strats.length,
      recentTrades: logs,
    });
  });

  return httpServer;
}
