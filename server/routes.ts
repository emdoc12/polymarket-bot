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

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {

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
      const [newestEvents, topEvents] = await Promise.all([
        polyFetch(GAMMA_API, "/events", {
          ...baseParams,
          active: "true",
          closed: "false",
          order: "startDate",
          ascending: "false",
        }) as Promise<any[]>,
        polyFetch(GAMMA_API, "/events", {
          ...baseParams,
          active: "true",
          closed: "false",
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

      if (search) {
        const term = search.toLowerCase();
        const filtered = allMarkets.filter((m: any) =>
          m.question?.toLowerCase().includes(term) ||
          m._eventTitle?.toLowerCase().includes(term)
        );
        res.json(filtered);
        return;
      }

      res.json(allMarkets);
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
