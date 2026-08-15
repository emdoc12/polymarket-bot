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

// Candidate strategies - parameterized specs proposed by the agent lab,
// tested against real settled Kalshi markets before any promotion.
export const candidateStrategies = sqliteTable("candidate_strategies", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  kind: text("kind").notNull().default("binary"), // binary (event contracts) | perp
  spec: text("spec").notNull(),               // JSON KalshiStrategySpec or PerpStrategySpec
  specHash: text("spec_hash").notNull().unique(),
  status: text("status").notNull().default("testing"), // testing | promoted | rejected
  createdBy: text("created_by").notNull(),     // agent role that proposed it
  rationale: text("rationale"),
  generation: integer("generation").notNull().default(1),
  trainTrades: integer("train_trades"),
  trainWins: integer("train_wins"),
  trainNetPnl: real("train_net_pnl"),
  holdoutTrades: integer("holdout_trades"),
  holdoutWins: integer("holdout_wins"),
  holdoutNetPnl: real("holdout_net_pnl"),
  // Walk-forward record: cumulative results on markets settled AFTER proposal.
  liveTrades: integer("live_trades"),
  liveWins: integer("live_wins"),
  liveNetPnl: real("live_net_pnl"),
  lastEvalCloseMs: integer("last_eval_close_ms"),
  lastTestedAt: text("last_tested_at"),
  pmNotes: text("pm_notes"),
  // Demo-account execution record, fed back by the executor.
  demoTrades: integer("demo_trades"),
  demoWins: integer("demo_wins"),
  demoNetPnl: real("demo_net_pnl"),
  createdAt: text("created_at").notNull(),
});

// Executor trades - orders placed (or dry-run recorded) on the Kalshi demo
// account by promoted strategies.
export const executorTrades = sqliteTable("executor_trades", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  candidateId: integer("candidate_id").references(() => candidateStrategies.id),
  candidateName: text("candidate_name").notNull(),
  ticker: text("ticker").notNull(),
  series: text("series").notNull(),
  side: text("side").notNull(),              // yes | no
  entryPrice: real("entry_price").notNull(), // dollars per contract
  contracts: integer("contracts").notNull(),
  cost: real("cost").notNull(),
  fee: real("fee").notNull(),
  status: text("status").notNull(),          // dry_run | open | settled_won | settled_lost | failed
  orderId: text("order_id"),
  error: text("error"),
  result: text("result"),                    // yes | no once settled
  netPnl: real("net_pnl"),
  placedAt: text("placed_at").notNull(),
  marketCloseAt: text("market_close_at").notNull(),
  settledAt: text("settled_at"),
});

// Agent lab runs - one row per research cycle
export const agentLabRuns = sqliteTable("agent_lab_runs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  ranAt: text("ran_at").notNull(),
  trigger: text("trigger").notNull(),          // manual | scheduled
  proposalsCount: integer("proposals_count").notNull().default(0),
  testedCount: integer("tested_count").notNull().default(0),
  promotedCount: integer("promoted_count").notNull().default(0),
  rejectedCount: integer("rejected_count").notNull().default(0),
  focus: text("focus"),
  pmCommentary: text("pm_commentary"),
  error: text("error"),
});

// Perp trades - long/short positions taken by the perps desk executor
export const perpTrades = sqliteTable("perp_trades", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  candidateId: integer("candidate_id").references(() => candidateStrategies.id),
  candidateName: text("candidate_name").notNull(),
  market: text("market").notNull(),
  side: text("side").notNull(),              // long | short
  entryPrice: real("entry_price"),
  exitPrice: real("exit_price"),
  contracts: real("contracts"),
  notional: real("notional"),
  entryFee: real("entry_fee"),
  exitFee: real("exit_fee"),
  status: text("status").notNull(),          // dry_run | open | closed | unfilled | failed
  exitReason: text("exit_reason"),           // take_profit | stop_loss | time_stop
  entryOrderId: text("entry_order_id"),
  exitOrderId: text("exit_order_id"),
  error: text("error"),
  netPnl: real("net_pnl"),
  openedAt: text("opened_at").notNull(),
  closedAt: text("closed_at"),
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

export const insertCandidateStrategySchema = createInsertSchema(candidateStrategies).omit({ id: true });
export const insertAgentLabRunSchema = createInsertSchema(agentLabRuns).omit({ id: true });
export const insertExecutorTradeSchema = createInsertSchema(executorTrades).omit({ id: true });
export const insertPerpTradeSchema = createInsertSchema(perpTrades).omit({ id: true });

// Types
export type CandidateStrategy = typeof candidateStrategies.$inferSelect;
export type InsertCandidateStrategy = z.infer<typeof insertCandidateStrategySchema>;
export type AgentLabRun = typeof agentLabRuns.$inferSelect;
export type InsertAgentLabRun = z.infer<typeof insertAgentLabRunSchema>;
export type ExecutorTrade = typeof executorTrades.$inferSelect;
export type InsertExecutorTrade = z.infer<typeof insertExecutorTradeSchema>;
export type PerpTrade = typeof perpTrades.$inferSelect;
export type InsertPerpTrade = z.infer<typeof insertPerpTradeSchema>;
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
