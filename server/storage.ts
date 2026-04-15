import {
  type Strategy, type InsertStrategy, strategies,
  type TradeLog, type InsertTradeLog, tradeLogs,
  type Watchlist, type InsertWatchlist, watchlist,
  type BotSetting, type InsertBotSetting, botSettings,
} from "@shared/schema";
import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import { eq, desc } from "drizzle-orm";

import path from "path";
const dbPath = process.env.DATA_DIR ? path.join(process.env.DATA_DIR, "data.db") : "data.db";
const sqlite = new Database(dbPath);
sqlite.pragma("journal_mode = WAL");

export const db = drizzle(sqlite);

export interface IStorage {
  // Strategies
  getStrategies(): Strategy[];
  getStrategy(id: number): Strategy | undefined;
  createStrategy(s: InsertStrategy): Strategy;
  updateStrategy(id: number, s: Partial<InsertStrategy>): Strategy | undefined;
  deleteStrategy(id: number): void;
  toggleStrategy(id: number, isActive: boolean): Strategy | undefined;
  markStrategyTriggered(id: number): void;

  // Trade logs
  getTradeLogs(limit?: number): TradeLog[];
  getTradeLogsByStrategy(strategyId: number): TradeLog[];
  createTradeLog(log: InsertTradeLog): TradeLog;

  // Watchlist
  getWatchlist(): Watchlist[];
  addToWatchlist(item: InsertWatchlist): Watchlist;
  removeFromWatchlist(id: number): void;

  // Bot settings
  getSetting(key: string): string | undefined;
  setSetting(key: string, value: string): void;
  getAllSettings(): BotSetting[];
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

  // Trade logs
  getTradeLogs(limit = 100): TradeLog[] {
    return db.select().from(tradeLogs).orderBy(desc(tradeLogs.id)).limit(limit).all();
  }

  getTradeLogsByStrategy(strategyId: number): TradeLog[] {
    return db.select().from(tradeLogs).where(eq(tradeLogs.strategyId, strategyId)).orderBy(desc(tradeLogs.id)).all();
  }

  createTradeLog(log: InsertTradeLog): TradeLog {
    return db.insert(tradeLogs).values(log).returning().get();
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
}

export const storage = new DatabaseStorage();
