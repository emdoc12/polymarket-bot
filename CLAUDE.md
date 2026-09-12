# PolyBot (jedi-poly) — Kalshi autonomous trading desk

Read this first. It is the handoff for any Claude session (cloud or local)
working on this repo. Last full update: 2026-09-12 (v1.13.0 era).

## What this is

An autonomous trading system for Kalshi 15-minute crypto/commodity up/down
markets, TRADING REAL MONEY on a production Kalshi account. A Claude Opus PM
directs Haiku specialist agents ("Strategy Lab") that invent strategy specs,
backtest them on real settled markets, walk-forward validate, and promote.
Promoted strategies flow: demo execution → prod audition (risk-free rehearsal
on real orderbooks) → live allowlist (real dollars).

Stack: Node/Express + TypeScript, esbuild → dist/index.cjs, React/Vite/
Tailwind/shadcn client, SQLite via Drizzle (better-sqlite3), additive
auto-migrations in server/storage.ts. `npx tsc` must pass before every
commit — dev/build use tsx/esbuild which SKIP typechecking.

## Deploy pipeline (fully automatic — this is why cloud sessions work)

1. Commit to `master` and push (standing permission granted by the user —
   push directly, no PRs needed).
2. GitHub Actions builds ghcr.io/emdoc12/polymarket-bot:latest (~1-2 min).
3. Watchtower on the user's Unraid box polls every 5 min and auto-deploys.

Push-to-live latency ≈ 3-8 minutes with zero human steps. ALWAYS bump the
`VERSION` file on behavior changes (the dashboard header shows it — it is how
the user confirms a deploy landed). Docs-only commits: add `[skip ci]` to the
commit message so the container isn't pointlessly restarted.

## CRITICAL limitation for cloud sessions

The deployed app lives on the user's LAN: `http://192.168.1.101:5000`.
A cloud session CANNOT reach it — no status checks, no /api/settings POSTs,
no verification against the box. You can still ship fixes (the pipeline
above is automatic); for anything needing runtime observation or a settings
flip, either give the user the exact `curl` command to run from home/phone,
or add what you need as code + defaults and let the deploy carry it.
Local (Mac) sessions CAN reach the box — use `curl http://192.168.1.101:5000/api/...`.

## Architecture map (server/)

- `kalshi.ts` — public market data client (prod hosts), strategy spec grammar
  (`KalshiStrategySpec`: series, sideRule, entrySecondsBeforeClose, price band,
  trendLookbackMinutes, minSignal, minHourEt/maxHourEt ET hour window),
  clampSpec/specHash, real-settled-market backtester (`evaluateSpecOnData`),
  candlestick fetch w/ 10s cache, normalCdf/valueModelProbUp fair-value model,
  CF-Benchmarks true-index history for backtests (fetchCfHistoryRange, HOUR
  chunks, Coinbase minute-candle fallback).
- `kalshi-trading.ts` — RSA-PSS signed private API, env-parameterized
  demo|prod (`KalshiEnv`), order placement (CreateOrder V2, IOC), shard
  collateral management, `fetchCfPassthrough` (CF Benchmarks REST passthrough).
- `agent-lab.ts` — the Strategy Lab: worker roles (Explorer/Optimizer/Skeptic,
  dedicated Commodities Explorer/Optimizer, 2 perp workers), Opus PM review,
  walk-forward scoring, per-asset-class pool budgets (crypto<300,
  commodities<150, perps<150) with frontier carve-out (zero-candidate venues
  always open), PM context digests: fill rates, REAL-MONEY by band, PROD
  AUDITION board, LIVE FORENSICS (hour/direction/streaks).
- `kalshi-executor.ts` — demo-account executor ($10 stakes). Exports
  `decideLiveEntry` — THE shared entry logic (all executors use it).
- `kalshi-live-executor.ts` — REAL-MONEY executor. Allowlist earned via
  evidence hierarchy (live record > prod audition > demo), requote-retry on
  empty IOC, price guards (0.30 floor / live_max_entry_price ceiling),
  trading-hours curfew, bankroll-proportional auto-stakes (computeLiveStake),
  kill switch. Arming requires POST /api/live/arm {"confirm":"GO LIVE"}.
- `kalshi-ws.ts` — prod WebSocket: orderbook_delta books (exact integer
  centi-contract math — floats caused ghost levels), cfbenchmarks_value_5hz
  settlement index (BRTI/ETHUSD_RTI), spot buffers + strike capture +
  realized vol, history backfill on boot (CF history lags ≤15 min → second
  pass at +12 min).
- `kalshi-ws-shadow.ts` — shadow executor: mirror rows (strict A/B vs REST
  live executor) + audition rows (EVERY promoted strategy rehearsed on real
  books, `audition=1`). Never places orders. Routes /api/ws-shadow/*,
  /api/spot/*.
- `kalshi-perps.ts`, `kalshi-perp-executor.ts` — perps desk (conclusive
  verdict: no edge in 1-min price action vs costs; PM keeps it unfunded).
- `storage.ts` — SQLite + migrations. Ledgers: executor_trades (demo),
  live_trades (REAL), ws_shadow_trades (shadow/audition), perp_trades.

## Live-money state & safety rails (as of 2026-09-12)

- Account: started $50 on 9/4; peaked +$27.70; a 7-loss streak 9/11 gave
  back ~$10; ~+$18, 65% win rate over ~165 settled. Evidence ≈ 1-2σ: real
  but thin; judge months not afternoons.
- Rails: kill switch −$25 cumulative (auto-disarms; NEVER loosen without
  explicit user instruction), max 2 open, one-position-per-window,
  entry ceiling 0.70 (live_max_entry_price), floor 0.30, curfew
  live_trading_hours_et=8-24 (overnight 0-8 ET measured −$16 vs +$30 for
  8-24), auto-stakes 4% of bankroll floored, $2 min / $10 cap
  (live_auto_stake / live_stake_fraction / live_max_order_size) — steps DOWN
  in drawdowns. Allowlist live_top_n=6, live_min_audition_trades=15.
- Transport: v1.15.0 added live_transport (rest|stream). Stream mode = ~2s
  ticks, entries priced off the WS book with depth-confirmation before
  firing (orders themselves always REST - Kalshi has no WS order channel);
  auto-fallback to REST quotes when stream is stale, per-trade 'transport'
  column records the path. Built after replaying all 140 REST misses: 73%
  would-have-won (~+$31 left on table, ~2.4 sigma vs filled trades' 60%).
- Loss clustering (P(loss|loss)=50% vs 30%) is railed as of v1.13.1: after
  3 consecutive live losses, no entries for 45 min (live_cooldown_losses /
  live_cooldown_minutes; 0 disables). Mirror applies it; audition exempt.

## Kalshi API facts (verified live)

- Prod REST `https://external-api.kalshi.com/trade-api/v2`, demo
  `https://demo-api.kalshi.co/trade-api/v2`. Public data needs no auth.
- Auth: RSA-PSS sign `timestampMs + METHOD + path` (path WITHOUT query).
  Prod creds in bot_settings `kalshi_prod_api_key_id` /
  `kalshi_prod_private_key_pem` (masked as `__secret_set__`; demo key id is
  `kalshi_api_key_id`). Secrets live ONLY in the box's SQLite — not in repo.
- Orders: POST /portfolio/events/orders — side bid(long YES)/ask(long NO),
  price = YES-leg fixed-point dollars (buy NO at 30c → ask "0.7000"),
  time_in_force immediate_or_cancel, count fixed-point string. Markets carry
  exchange_index (shards); collateral preallocated per shard via
  intra_exchange_instance_transfer (amount in CENTICENTS, $1=10000).
- Fees: quadratic ≈ ceil(0.07·contracts·P·(1−P)) — breakeven win rate rises
  with entry price: 71% needed at 75c, prints at 55c. Premium bands bleed.
- WS `wss://external-api-ws.kalshi.com/trade-api/ws/v2` (fallback
  api.elections.kalshi.com), same signing on the WS path. Channels used:
  orderbook_delta (seq per sid; gap → resync), cfbenchmarks_value_5hz.
- CF history: GET /trade-api/v2/cfbenchmarks/history/values?id=BRTI&
  timespan=HOUR&timestamp=<ISO hour> → {data:{payload:[{time(ms),value}]}}
  at 200ms; DAY-size requests 503; history lags real time ≤15 min.

## Useful endpoints (LAN only: http://192.168.1.101:5000)

/api/version · /api/live/status|trades|pnl-series · /api/live/arm|disarm|
reset-kill-switch · /api/ws-shadow/status|compare|audition|reset ·
/api/spot/status|history-probe · /api/agent-lab/status|candidates|runs|run ·
/api/executor/status|pnl-series · POST /api/settings {key,value} (rejects
live_executor_enabled=true and live_kill_switch — use dedicated routes).

## Conventions & gotchas

- Import zod as `zod/v4` for Anthropic structured outputs (drizzle-zod stays v3).
- Structured-output workers: keep max_tokens headroom; truncation loses the
  whole response — fault-isolate every agent call.
- Demo counterparties are seeded MMs; prod is real crowds. Evidence ranks:
  realMoney > prodAudition > demo > walk-forward > discovery. Never let demo
  shine override live losses.
- Value rule ("value" sideRule) is crypto-only (no free settlement feed for
  Pyth-settled commodities; declined $1k/mo Pyth subscription).
- The dashboard client caches its HTML shell — after deploys the user may
  need a force-refresh; backend /api/version is always truthful.
- Commit style: descriptive multi-line messages, version-first subject
  ("v1.x.y - What changed"), end with the Claude co-author line.
- User preference: build decisively, verify against real data, report
  outcomes with honest statistics (σ context, sample sizes). Track record of
  approving: safety rails, evidence-driven tweaks, forensics. Money-touching
  parameter changes (kill switch, stake fraction/cap raises) need explicit
  user approval; the user runs sequenced rollouts themselves only for OTHER
  repos — this repo has standing push permission.

## Parked / open threads

- Streaming (WS) order path: build only when audition math justifies it.
- NFL scout desk: scoped and parked (divergence scanner vs sportsbook
  consensus, needs free the-odds-api.com key, paper ledger first).
- Perps: unfunded pending a fee-modeled backtest ≥50 scored trades/split.
- jedi-trading repo's Watchtower auto-update is broken (private GHCR
  package, 403) — fix is REPO_USER/REPO_PASS env on Watchtower with a
  read:packages PAT. Separate repo, user-side task.
