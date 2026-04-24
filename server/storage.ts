import {
  type Strategy, type InsertStrategy, strategies,
  type TradeLog, type InsertTradeLog, tradeLogs,
  type Watchlist, type InsertWatchlist, watchlist,
  type BotSetting, type InsertBotSetting, botSettings,
  type BacktestRun, type InsertBacktestRun, backtestRuns,
} from "@shared/schema";
import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import { eq, desc } from "drizzle-orm";

import path from "path";
const dbPath = process.env.DATA_DIR ? path.join(process.env.DATA_DIR, "data.db") : "data.db";
const sqlite = new Database(dbPath);
sqlite.pragma("journal_mode = WAL");

export const db = drizzle(sqlite);

// Auto-migrate: create tables and add missing columns without wiping data
function runMigrations() {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS strategies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      market_slug TEXT,
      condition_id TEXT,
      token_id TEXT,
      side TEXT NOT NULL,
      trigger_type TEXT NOT NULL,
      trigger_price REAL NOT NULL,
      order_size REAL NOT NULL,
      order_type TEXT NOT NULL DEFAULT 'LIMIT',
      limit_price REAL,
      is_active INTEGER NOT NULL DEFAULT 1,
      cooldown_minutes INTEGER NOT NULL DEFAULT 5,
      last_triggered TEXT,
      total_executions INTEGER NOT NULL DEFAULT 0,
      market_question TEXT,
      auto_roll INTEGER NOT NULL DEFAULT 0,
      current_condition_id TEXT
    );
    CREATE TABLE IF NOT EXISTS trade_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      strategy_id INTEGER REFERENCES strategies(id),
      strategy_name TEXT,
      market_id TEXT,
      condition_id TEXT,
      token_id TEXT NOT NULL,
      side TEXT NOT NULL,
      outcome TEXT NOT NULL,
      price REAL NOT NULL,
      size REAL NOT NULL,
      status TEXT NOT NULL,
      order_id TEXT,
      error_message TEXT,
      timestamp TEXT NOT NULL,
      market_question TEXT
    );
    CREATE TABLE IF NOT EXISTS watchlist (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      condition_id TEXT NOT NULL UNIQUE,
      token_id TEXT NOT NULL,
      market_question TEXT NOT NULL,
      added_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS bot_settings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT NOT NULL UNIQUE,
      value TEXT NOT NULL
    );
  `);

  // Add columns that may be missing on older databases
  const stratCols = sqlite.pragma("table_info(strategies)") as { name: string }[];
  const stratColNames = new Set(stratCols.map((c) => c.name));
  if (!stratColNames.has("auto_roll")) sqlite.exec("ALTER TABLE strategies ADD COLUMN auto_roll INTEGER NOT NULL DEFAULT 0;");
  if (!stratColNames.has("current_condition_id")) sqlite.exec("ALTER TABLE strategies ADD COLUMN current_condition_id TEXT;");
  if (!stratColNames.has("total_pnl")) sqlite.exec("ALTER TABLE strategies ADD COLUMN total_pnl REAL NOT NULL DEFAULT 0;");
  if (!stratColNames.has("win_count")) sqlite.exec("ALTER TABLE strategies ADD COLUMN win_count INTEGER NOT NULL DEFAULT 0;");
  if (!stratColNames.has("loss_count")) sqlite.exec("ALTER TABLE strategies ADD COLUMN loss_count INTEGER NOT NULL DEFAULT 0;");
  if (!stratColNames.has("config")) sqlite.exec("ALTER TABLE strategies ADD COLUMN config TEXT;");

  const logCols = sqlite.pragma("table_info(trade_logs)") as { name: string }[];
  const logColNames = new Set(logCols.map((c) => c.name));
  if (!logColNames.has("strategy_name")) sqlite.exec("ALTER TABLE trade_logs ADD COLUMN strategy_name TEXT;");
  if (!logColNames.has("market_id")) sqlite.exec("ALTER TABLE trade_logs ADD COLUMN market_id TEXT;");
  if (!logColNames.has("condition_id")) sqlite.exec("ALTER TABLE trade_logs ADD COLUMN condition_id TEXT;");
  if (!logColNames.has("exit_price")) sqlite.exec("ALTER TABLE trade_logs ADD COLUMN exit_price REAL;");
  if (!logColNames.has("pnl")) sqlite.exec("ALTER TABLE trade_logs ADD COLUMN pnl REAL;");
  if (!logColNames.has("pnl_percent")) sqlite.exec("ALTER TABLE trade_logs ADD COLUMN pnl_percent REAL;");
  if (!logColNames.has("closed_at")) sqlite.exec("ALTER TABLE trade_logs ADD COLUMN closed_at TEXT;");
  if (!logColNames.has("fee_paid")) sqlite.exec("ALTER TABLE trade_logs ADD COLUMN fee_paid REAL;");
  if (!logColNames.has("net_pnl")) sqlite.exec("ALTER TABLE trade_logs ADD COLUMN net_pnl REAL;");

  // Backtest runs table
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS backtest_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      strategy_name TEXT NOT NULL,
      ran_at TEXT NOT NULL,
      period_days INTEGER NOT NULL,
      total_trades INTEGER NOT NULL,
      wins INTEGER NOT NULL,
      losses INTEGER NOT NULL,
      win_rate REAL NOT NULL,
      gross_pnl REAL NOT NULL,
      total_fees REAL NOT NULL,
      net_pnl REAL NOT NULL,
      edge_pct REAL NOT NULL,
      meets_target INTEGER NOT NULL
    );
  `);
}

runMigrations();

export interface IStorage {
  // Strategies
  getStrategies(): Strategy[];
  getStrategy(id: number): Strategy | undefined;
  createStrategy(s: InsertStrategy): Strategy;
  updateStrategy(id: number, s: Partial<InsertStrategy>): Strategy | undefined;
  deleteStrategy(id: number): void;
  toggleStrategy(id: number, isActive: boolean): Strategy | undefined;
  markStrategyTriggered(id: number): void;
  updateStrategyPnl(id: number, pnl: number, won: boolean): void;
  upsertStrategies(defaults: InsertStrategy[]): void;

  // Trade logs
  getTradeLogs(limit?: number): TradeLog[];
  getTradeLog(id: number): TradeLog | undefined;
  getTradeLogsByStrategy(strategyId: number): TradeLog[];
  getOpenTradeByStrategyAndCondition(strategyId: number, conditionId: string): TradeLog | undefined;
  getOpenTrades(): TradeLog[];
  createTradeLog(log: InsertTradeLog): TradeLog;
  updateTradeLog(id: number, updates: Partial<TradeLog>): void;

  // Watchlist
  getWatchlist(): Watchlist[];
  addToWatchlist(item: InsertWatchlist): Watchlist;
  removeFromWatchlist(id: number): void;

  // Bot settings
  getSetting(key: string): string | undefined;
  setSetting(key: string, value: string): void;
  getAllSettings(): BotSetting[];

  // Backtest runs
  saveBacktestRun(run: InsertBacktestRun): BacktestRun;
  getBacktestRuns(strategyName?: string): BacktestRun[];
  clearBacktestRuns(): void;
}

export class DatabaseStorage implements IStorage {
  // Strategies
  getStrategies(): Strategy[] {
    return db.select().from(strategies).all();
  }

  getStrategy(id: number): Strategy | undefined {
    return db.select().from(strategies).where(eq(strategies.id, id)).get();
  }

  createStrategy(s: InsertStrategy): Strategy {
    return db.insert(strategies).values(s).returning().get();
  }

  updateStrategy(id: number, s: Partial<InsertStrategy>): Strategy | undefined {
    const existing = this.getStrategy(id);
    if (!existing) return undefined;
    return db.update(strategies).set(s).where(eq(strategies.id, id)).returning().get();
  }

  deleteStrategy(id: number): void {
    db.delete(strategies).where(eq(strategies.id, id)).run();
  }

  toggleStrategy(id: number, isActive: boolean): Strategy | undefined {
    return db.update(strategies).set({ isActive }).where(eq(strategies.id, id)).returning().get();
  }

  markStrategyTriggered(id: number): void {
    const s = this.getStrategy(id);
    if (!s) return;
    db.update(strategies).set({
      lastTriggered: new Date().toISOString(),
      totalExecutions: s.totalExecutions + 1,
    }).where(eq(strategies.id, id)).run();
  }

  updateStrategyPnl(id: number, pnl: number, won: boolean): void {
    const s = this.getStrategy(id);
    if (!s) return;
    db.update(strategies).set({
      totalPnl: (s.totalPnl ?? 0) + pnl,
      winCount: won ? (s.winCount ?? 0) + 1 : (s.winCount ?? 0),
      lossCount: !won ? (s.lossCount ?? 0) + 1 : (s.lossCount ?? 0),
    }).where(eq(strategies.id, id)).run();
  }

  upsertStrategies(defaults: InsertStrategy[]): void {
    // Insert each strategy only if no strategy with that name exists yet
    const existing = this.getStrategies();
    const existingNames = new Set(existing.map((s) => s.name));
    for (const s of defaults) {
      if (!existingNames.has(s.name)) {
        db.insert(strategies).values(s).run();
      }
    }
  }

  // Trade logs
  getTradeLogs(limit = 100): TradeLog[] {
    return db.select().from(tradeLogs).orderBy(desc(tradeLogs.id)).limit(limit).all();
  }

  getTradeLog(id: number): TradeLog | undefined {
    return db.select().from(tradeLogs).where(eq(tradeLogs.id, id)).get();
  }

  getTradeLogsByStrategy(strategyId: number): TradeLog[] {
    return db.select().from(tradeLogs).where(eq(tradeLogs.strategyId, strategyId)).orderBy(desc(tradeLogs.id)).all();
  }

  getOpenTradeByStrategyAndCondition(strategyId: number, conditionId: string): TradeLog | undefined {
    return this.getTradeLogsByStrategy(strategyId).find(
      (trade) => trade.conditionId === conditionId && trade.status === "open",
    );
  }

  getOpenTrades(): TradeLog[] {
    return db.select().from(tradeLogs).orderBy(desc(tradeLogs.id)).all().filter((trade) => trade.status === "open");
  }

  createTradeLog(log: InsertTradeLog): TradeLog {
    return db.insert(tradeLogs).values(log).returning().get();
  }

  updateTradeLog(id: number, updates: Partial<TradeLog>): void {
    db.update(tradeLogs).set(updates as any).where(eq(tradeLogs.id, id)).run();
  }

  // Watchlist
  getWatchlist(): Watchlist[] {
    return db.select().from(watchlist).all();
  }

  addToWatchlist(item: InsertWatchlist): Watchlist {
    return db.insert(watchlist).values(item).returning().get();
  }

  removeFromWatchlist(id: number): void {
    db.delete(watchlist).where(eq(watchlist.id, id)).run();
  }

  // Bot settings
  getSetting(key: string): string | undefined {
    const row = db.select().from(botSettings).where(eq(botSettings.key, key)).get();
    return row?.value;
  }

  setSetting(key: string, value: string): void {
    const existing = db.select().from(botSettings).where(eq(botSettings.key, key)).get();
    if (existing) {
      db.update(botSettings).set({ value }).where(eq(botSettings.key, key)).run();
    } else {
      db.insert(botSettings).values({ key, value }).run();
    }
  }

  getAllSettings(): BotSetting[] {
    return db.select().from(botSettings).all();
  }

  saveBacktestRun(run: InsertBacktestRun): BacktestRun {
    return db.insert(backtestRuns).values(run).returning().get();
  }

  getBacktestRuns(strategyName?: string): BacktestRun[] {
    if (strategyName) {
      return db.select().from(backtestRuns)
        .where(eq(backtestRuns.strategyName, strategyName))
        .orderBy(desc(backtestRuns.id)).all();
    }
    return db.select().from(backtestRuns).orderBy(desc(backtestRuns.id)).all();
  }

  clearBacktestRuns(): void {
    db.delete(backtestRuns).run();
  }
}

export const storage = new DatabaseStorage();
