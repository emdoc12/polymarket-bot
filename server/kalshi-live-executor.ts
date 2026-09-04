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
import {
  ensureShardFundsEnv,
  getKalshiAuthStatusEnv,
  getKalshiBalanceEnv,
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
}

function liveTradesToday() {
  const today = new Date().toISOString().slice(0, 10);
  return storage.getLiveTrades(300)
    .filter((t) => t.placedAt.startsWith(today) && t.status !== "failed").length;
}

function liveTotalNetPnl() {
  return storage.getLiveTrades(10000)
    .filter((t) => t.netPnl != null)
    .reduce((sum, t) => sum + (t.netPnl ?? 0), 0);
}

// The allowlist is earned, not configured: only promoted binary strategies
// with a real, positive demo execution record qualify, ranked by demo P&L.
export function getLiveArmedStrategies(): CandidateStrategy[] {
  const topN = Math.max(1, parseInt(storage.getSetting("live_top_n") || "3", 10));
  const minDemo = Math.max(1, parseInt(storage.getSetting("live_min_demo_trades") || "20", 10));
  return storage.getCandidateStrategies("promoted")
    .filter((c) => c.kind !== "perp")
    .filter((c) => (c.demoTrades ?? 0) >= minDemo && (c.demoNetPnl ?? 0) > 0)
    .sort((a, b) => (b.demoNetPnl ?? 0) - (a.demoNetPnl ?? 0))
    .slice(0, topN);
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
      const payout = won ? trade.contracts : 0;
      const netPnl = payout - trade.cost - trade.fee;
      storage.updateLiveTrade(trade.id, {
        status: won ? "settled_won" : "settled_lost",
        result,
        netPnl,
        settledAt: new Date().toISOString(),
      });

      const maxLoss = parseFloat(storage.getSetting("live_max_total_loss") || "25");
      const total = liveTotalNetPnl();
      if (Number.isFinite(maxLoss) && total <= -Math.abs(maxLoss)) {
        tripKillSwitch(`cumulative live net P&L ${total.toFixed(2)} breached -$${Math.abs(maxLoss).toFixed(2)} limit`);
      }
    } catch {
      continue;
    }
  }
}

async function tryLiveEntry(candidate: CandidateStrategy, spec: KalshiStrategySpec, market: KalshiMarket, nowMs: number) {
  const decision = await decideLiveEntry(spec, market, nowMs);
  if (!decision.ok) return;

  const minFillable = parseFloat(storage.getSetting("executor_min_fillable_price") || "0.30");
  if (Number.isFinite(minFillable) && decision.entryPrice < minFillable) return;

  const orderSize = Math.max(0.5, parseFloat(storage.getSetting("live_order_size") || "2"));
  let contracts = Math.max(1, Math.floor(orderSize / decision.entryPrice));
  let entryPrice = decision.entryPrice;
  let cost = contracts * entryPrice;
  let fee = kalshiTradingFee(contracts, entryPrice);
  const priceCents = Math.min(99, Math.max(1, Math.round(decision.entryPrice * 100)));

  let status = "failed";
  let orderId: string | null = null;
  let error: string | null = null;
  try {
    const exchangeIndex = await getMarketExchangeIndexEnv("prod", market.ticker);
    if (exchangeIndex == null) throw new Error(`market ${market.ticker} is not listed on the prod exchange`);
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
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
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
    placedAt: new Date().toISOString(),
    marketCloseAt: market.close_time ?? new Date(nowMs).toISOString(),
    settledAt: null,
  });
}

async function runLiveTick() {
  await settleLiveTrades();

  if (!liveEnabled()) return;
  if (!getKalshiAuthStatusEnv("prod").configured) return;

  const armed = getLiveArmedStrategies();
  if (armed.length === 0) return;

  const maxOpen = Math.max(1, parseInt(storage.getSetting("live_max_open_trades") || "2", 10));
  const maxPerDay = Math.max(1, parseInt(storage.getSetting("live_max_trades_per_day") || "20", 10));
  if (storage.getUnsettledLiveTrades().length >= maxOpen) return;
  if (liveTradesToday() >= maxPerDay) return;

  const specs = armed.map((candidate) => ({ candidate, spec: clampSpec(JSON.parse(candidate.spec)) }));
  const seriesNeeded = [...new Set(specs.map((s) => s.spec.series))];
  const nowMs = Date.now();

  for (const series of seriesNeeded) {
    let markets: KalshiMarket[] = [];
    try {
      markets = (await getKalshiMarkets({ seriesTicker: series, status: "open", limit: 10 })).markets;
    } catch {
      continue;
    }
    const active = markets
      .map((market) => ({ market, closeMs: market.close_time ? new Date(market.close_time).getTime() : NaN }))
      .filter((entry) => Number.isFinite(entry.closeMs) && entry.closeMs > nowMs)
      .sort((a, b) => a.closeMs - b.closeMs)[0];
    if (!active) continue;

    const secondsToClose = (active.closeMs - nowMs) / 1000;
    for (const { candidate, spec } of specs) {
      if (spec.series !== series) continue;
      if (secondsToClose > spec.entrySecondsBeforeClose) continue;
      if (secondsToClose < spec.entrySecondsBeforeClose - ENTRY_TOLERANCE_SEC) continue;
      if (storage.hasLiveTradeFor(candidate.id, active.market.ticker)) continue;
      // Real money: one position per window, full stop - correlated strategies
      // never stack live.
      if (storage.getLiveTrades(50).some((t) => t.ticker === active.market.ticker && t.status !== "failed")) continue;
      if (storage.getUnsettledLiveTrades().length >= maxOpen) break;
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
  const intervalSec = Math.max(10, parseInt(storage.getSetting("live_poll_seconds") || "15", 10));
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
      openTrades: storage.getUnsettledLiveTrades().length,
      tradesToday: liveTradesToday(),
      orderSize: parseFloat(storage.getSetting("live_order_size") || "2"),
      maxOpenTrades: parseInt(storage.getSetting("live_max_open_trades") || "2", 10),
      maxTradesPerDay: parseInt(storage.getSetting("live_max_trades_per_day") || "20", 10),
      maxTotalLoss: parseFloat(storage.getSetting("live_max_total_loss") || "25"),
      totalSettled: settled.length,
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
