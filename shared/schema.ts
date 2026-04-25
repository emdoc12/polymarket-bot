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
  autoRoll: integer("auto_roll", { mode: "boolean" }).notNull().default(false), // auto-roll to next candle
  currentConditionId: text("current_condition_id"), // tracks the current active candle being traded
  // P&L tracking per strategy
  totalPnl: real("total_pnl").notNull().default(0),
  winCount: integer("win_count").notNull().default(0),
  lossCount: integer("loss_count").notNull().default(0),
  // Strategy config (JSON blob for flexible per-strategy params)
  config: text("config"), // JSON string e.g. {"mainSize":0.8,"hedgeSize":0.2,"tpPct":0.03,"slPct":0.015}
});

// Trade log table - records of executed or attempted trades
export const tradeLogs = sqliteTable("trade_logs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  strategyId: integer("strategy_id").references(() => strategies.id),
  strategyName: text("strategy_name"), // snapshot of strategy name at trade time
  marketId: text("market_id"),
  conditionId: text("condition_id"),
  tokenId: text("token_id").notNull(),
  side: text("side").notNull(), // BUY or SELL
  outcome: text("outcome").notNull(), // YES or NO
  tradeGroupId: text("trade_group_id"),
  price: real("price").notNull(),
  size: real("size").notNull(),
  status: text("status").notNull(), // "open", "closed", "failed", "simulated", "pending_resolution"
  orderId: text("order_id"),
  errorMessage: text("error_message"),
  timestamp: text("timestamp").notNull(),
  marketQuestion: text("market_question"),
  // P&L tracking
  exitPrice: real("exit_price"),       // price at close/resolution
  pnl: real("pnl"),                   // realised P&L in USDC (gross)
  pnlPercent: real("pnl_percent"),    // % return
  closedAt: text("closed_at"),        // ISO timestamp of close
  feePaid: real("fee_paid"),          // taker fee deducted (USDC)
  netPnl: real("net_pnl"),            // pnl - feePaid
});

// Watchlist - tracked markets
export const watchlist = sqliteTable("watchlist", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  conditionId: text("condition_id").notNull().unique(),
  tokenId: text("token_id").notNull(),
  marketQuestion: text("market_question").notNull(),
  addedAt: text("added_at").notNull(),
});

// Backtest results
export const backtestRuns = sqliteTable("backtest_runs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  strategyName: text("strategy_name").notNull(),
  ranAt: text("ran_at").notNull(),           // ISO timestamp
  periodDays: integer("period_days").notNull(),
  totalTrades: integer("total_trades").notNull(),
  wins: integer("wins").notNull(),
  losses: integer("losses").notNull(),
  winRate: real("win_rate").notNull(),        // 0-1
  grossPnl: real("gross_pnl").notNull(),
  totalFees: real("total_fees").notNull(),
  netPnl: real("net_pnl").notNull(),
  edgePct: real("edge_pct").notNull(),        // avg edge per trade %
  meetsTarget: integer("meets_target", { mode: "boolean" }).notNull(), // winRate >= 0.65 && edge >= 0.03
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
export const insertBacktestRunSchema = createInsertSchema(backtestRuns).omit({ id: true });

// Types
export type Strategy = typeof strategies.$inferSelect;
export type BacktestRun = typeof backtestRuns.$inferSelect;
export type InsertBacktestRun = z.infer<typeof insertBacktestRunSchema>;
export type InsertStrategy = z.infer<typeof insertStrategySchema>;
export type TradeLog = typeof tradeLogs.$inferSelect;
export type InsertTradeLog = z.infer<typeof insertTradeLogSchema>;
export type Watchlist = typeof watchlist.$inferSelect;
export type InsertWatchlist = z.infer<typeof insertWatchlistSchema>;
export type BotSetting = typeof botSettings.$inferSelect;
export type InsertBotSetting = z.infer<typeof insertBotSettingSchema>;
