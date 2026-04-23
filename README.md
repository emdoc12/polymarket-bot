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

## Releases

- Git tags like `v1.5.3` publish both the `latest` container tag and the matching versioned image tag
- Bump [`VERSION`](/Users/emdoc12/jedi-poly/VERSION) and `package.json` together before tagging a release

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
