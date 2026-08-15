# PolyBot — Polymarket Automated Trading Bot

A self-hosted web app for paper-trading rolling BTC 5-minute markets on [Polymarket](https://polymarket.com). Browse live markets, run BTC-specific trigger strategies, and automatically roll paper positions from one 5-minute candle into the next while you test.

---

## Features

- **Live Markets** — Browse and search Polymarket markets with real-time odds and volume
- **Strategy Builder** — Create rules: buy YES when price drops below X%, sell NO when above Y%
- **Paper Mode** — Simulate strategies against live prices with no real funds at risk
- **Paper-Only Execution** — No live order placement while you validate signals, fees, and rollover behavior
- **Trade Log** — Full audit trail of every execution and simulation
- **Watchlist** — Track markets and refresh prices on demand
- **Safety Limits** — Max daily trades, max order size, configurable polling interval
- **Dark/Light Mode** — Full dark mode support

---

## Unraid Setup (Compose Manager)

### Step 1 — Install Compose Manager

In the Unraid **Apps** tab, search for **Compose Manager** and install it.

### Step 2 — Create the stack

1. Go to the **Docker** tab and scroll to the bottom
2. Click **Add New Stack**, name it `polybot`, click **Add**
3. Click the **gear icon** next to the stack → **Edit Stack**
4. Paste the following into the compose file editor:

```yaml
services:
  polybot:
    image: ghcr.io/emdoc12/polymarket-bot:latest
    container_name: polybot
    restart: unless-stopped
    ports:
      - "5000:5000"
    volumes:
      - /mnt/user/appdata/polybot:/data
    environment:
      - NODE_ENV=production
      - DATA_DIR=/data
```

5. Click **Save Changes**
6. Click **Compose Up**

### Step 3 — Access the app

Open `http://[your-unraid-ip]:5000` in your browser.

### Updating

When a new version is available, in the Docker tab on your stack:
1. Click **Compose Pull**
2. Click **Compose Up**

---

## Running with Docker (non-Unraid)

```bash
docker compose up -d
```

Or manually:

```bash
docker run -d \
  -p 5000:5000 \
  -v polybot-data:/data \
  --name polybot \
  ghcr.io/emdoc12/polymarket-bot:latest
```

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `NODE_ENV` | Yes | Set to `production` |
| `DATA_DIR` | No | Path to SQLite data directory (default: `/data`) |
---

## Current Scope

- Paper trading only
- Focused on the rolling Bitcoin 5-minute “Up or Down” markets
- Positions stay attached to the market they entered and settle when that candle resolves
- Active strategies can automatically roll into the next BTC 5-minute market

## Kalshi (Phase 1 — market data + real backtests)

The app is migrating toward live trading on [Kalshi](https://kalshi.com) (KXBTC15M
15-minute BTC up/down and hourly series). Phase 1 adds public market-data
endpoints — no API key needed:

- `GET /api/kalshi/series` — supported crypto series
- `GET /api/kalshi/markets?series=KXBTC15M&status=open` — live markets
- `GET /api/kalshi/orderbook/:ticker` — order book
- `GET /api/kalshi/candles?series=KXBTC15M&ticker=...` — 1-min history (price + yes bid/ask)
- `POST /api/kalshi/backtest` — replay real settled markets with actual quoted
  entries, real settlement results, and Kalshi's quadratic fee
  (`{"series":"KXBTC15M","marketsLookback":40,"entrySecondsBeforeClose":300,"strategy":"momentum","orderSize":10}`)

### Phase 2 — demo-environment trading (built, awaiting API key)

Authenticated demo trading is implemented with RSA-PSS request signing.
Orders are **hard-coded to the demo environment** (production orders are
disabled until Phase 3) and **dry-run mode is on by default** — intended
orders are logged, not sent, until `kalshi_dry_run` is set to `false` in
settings *and* credentials exist.

Configure credentials (from a [demo.kalshi.co](https://demo.kalshi.co)
account, Profile Settings → API Keys), either via env vars:

```yaml
environment:
  - KALSHI_API_KEY_ID=your-key-id
  - KALSHI_PRIVATE_KEY_PATH=/data/kalshi-api-key.pem
```

or the Unraid-friendly way: drop the PEM at `/mnt/user/appdata/polybot/kalshi-api-key.pem`
and save the key id as the `kalshi_api_key_id` setting.

- `GET /api/kalshi/auth/status` — credential/dry-run state
- `POST /api/kalshi/auth/self-test` — local sign/verify + live balance probe
- `GET /api/kalshi/balance` / `positions` / `portfolio-orders` / `fills`
- `POST /api/kalshi/orders` — `{"ticker":"...","side":"yes","action":"buy","count":10,"type":"limit","yesPriceCents":45}`
- `DELETE /api/kalshi/orders/:orderId`
- `GET /api/kalshi/dry-run-log` — orders that would have been sent

## Strategy Lab — AI agent research team

A PM (Claude Opus 5) directs a team of specialist agents (Claude Haiku 4.5) that
invent, mutate, and stress-test parameterized strategy specs. Every proposal is
backtested against real settled Kalshi markets with a chronological
train/holdout split; the PM promotes only candidates whose edge survives the
holdout sample. Roles: Explorer (novel specs), Optimizer (mutations of
leaders), Skeptic (robustness checks + overfitting flags).

Requires `ANTHROPIC_API_KEY` in the container environment. Disabled by default;
enable with the `agent_lab_enabled` setting. Guardrails: `agent_lab_interval_minutes`
(default 30), `agent_lab_max_candidates_per_cycle` (8), `agent_lab_max_cycles_per_day` (24).
Approximate cost per cycle: a few cents (3 Haiku calls + 1 Opus call).

- `GET /api/agent-lab/status` — config, guardrails, candidate counts
- `POST /api/agent-lab/run` — run one research cycle now
- `GET /api/agent-lab/candidates?status=testing|promoted|rejected` — leaderboard
- `GET /api/agent-lab/runs` — cycle history with PM commentary
- `POST /api/kalshi/spec-backtest` — test any spec by hand against real markets

### Perps desk

The lab also researches strategies for Kalshi's perpetual futures (the one
crypto venue where the demo exchange has real seeded liquidity, so demo fills
are genuine). Perp specs are long/short with TP/SL/time-stop exits, $50
notional, backtested and walk-forwarded on real 1-minute candles. The perp
executor manages positions with reduce-only exits and strict caps (2 open,
40/day). Toggle: `perp_executor_enabled` (Lab page switch).

- `GET /api/perps/markets` — mark price, funding rate, open interest
- `POST /api/perps/spec-backtest` — test a perp spec on real candle history
- `GET /api/perps/executor/status` · `GET /api/perps/trades`

## Releases

- Pushes to `master` publish both the `latest` container tag and the current version tag from [`VERSION`](/Users/emdoc12/jedi-poly/VERSION)
- Put the version number in the commit title, then push to `master`

---

## Development

```bash
npm install
npm run dev     # starts Express + Vite on port 5000
```

### Tech Stack

- **Backend**: Node.js, Express, SQLite (via Drizzle ORM)
- **Frontend**: React, Vite, Tailwind CSS, shadcn/ui
- **Market Data**: Polymarket Gamma API + CLOB API

---

## Data Persistence

All data is stored in a SQLite database at `/data/data.db` inside the container. The Unraid volume mapping (`/mnt/user/appdata/polybot`) keeps your data safe across updates.
