import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// Strategies table - automated trading rules
export const strategies = sqliteTable("strategies", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  marketSlug: text("market_slug"), // optional - if tied to a specific market
  conditionId: text("condition_id"), // polymarket condition ID
  tokenId: text("token_id"), // CLOB token ID
  side: text("side").notNull(), // "YES" or "NO"
  triggerType: text("trigger_type").notNull(), // "price_below", "price_above", "price_cross"
  triggerPrice: real("trigger_price").notNull(), // probability threshold (0-1)
  orderSize: real("order_size").notNull(), // amount in USDC
  orderType: text("order_type").notNull().default("LIMIT"), // LIMIT or MARKET
  limitPrice: real("limit_price"), // for limit orders
  isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
  cooldownMinutes: integer("cooldown_minutes").notNull().default(5),
  lastTriggered: text("last_triggered"), // ISO timestamp
  totalExecutions: integer("total_executions").notNull().default(0),
  marketQuestion: text("market_question"), // cached market question text
});

// Trade log table - records of executed or attempted trades
export const tradeLogs = sqliteTable("trade_logs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  strategyId: integer("strategy_id").references(() => strategies.id),
  tokenId: text("token_id").notNull(),
  side: text("side").notNull(), // BUY or SELL
  outcome: text("outcome").notNull(), // YES or NO
  price: real("price").notNull(),
  size: real("size").notNull(),
  status: text("status").notNull(), // "pending", "filled", "failed", "simulated"
  orderId: text("order_id"),
  errorMessage: text("error_message"),
  timestamp: text("timestamp").notNull(),
  marketQuestion: text("market_question"),
});

// Watchlist - tracked markets
export const watchlist = sqliteTable("watchlist", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  conditionId: text("condition_id").notNull().unique(),
  tokenId: text("token_id").notNull(),
  marketQuestion: text("market_question").notNull(),
  addedAt: text("added_at").notNull(),
});

// Bot settings
export const botSettings = sqliteTable("bot_settings", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  key: text("key").notNull().unique(),
  value: text("value").notNull(),
});

// Insert schemas
export const insertStrategySchema = createInsertSchema(strategies).omit({ id: true, totalExecutions: true, lastTriggered: true });
export const insertTradeLogSchema = createInsertSchema(tradeLogs).omit({ id: true });
export const insertWatchlistSchema = createInsertSchema(watchlist).omit({ id: true });
export const insertBotSettingSchema = createInsertSchema(botSettings).omit({ id: true });

// Types
export type Strategy = typeof strategies.$inferSelect;
export type InsertStrategy = z.infer<typeof insertStrategySchema>;
export type TradeLog = typeof tradeLogs.$inferSelect;
export type InsertTradeLog = z.infer<typeof insertTradeLogSchema>;
export type Watchlist = typeof watchlist.$inferSelect;
export type InsertWatchlist = z.infer<typeof insertWatchlistSchema>;
export type BotSetting = typeof botSettings.$inferSelect;
export type InsertBotSetting = z.infer<typeof insertBotSettingSchema>;
