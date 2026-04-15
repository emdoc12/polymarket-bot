# PolyBot — Polymarket Automated Trading Bot

A self-hosted web app for automating trades on [Polymarket](https://polymarket.com). Browse live prediction markets, build trigger-based trading strategies, simulate them in paper mode, and optionally execute real on-chain trades via the Polymarket CLOB API.

---

## Features

- **Live Markets** — Browse and search Polymarket markets with real-time odds and volume
- **Strategy Builder** — Create rules: buy YES when price drops below X%, sell NO when above Y%
- **Paper Mode** — Simulate strategies against live prices with no real funds at risk
- **Live Mode** — Execute real orders on-chain via the Polymarket CLOB (requires wallet + API credentials)
- **Trade Log** — Full audit trail of every execution and simulation
- **Watchlist** — Track markets and refresh prices on demand
- **Safety Limits** — Max daily trades, max order size, configurable polling interval
- **Dark/Light Mode** — Full dark mode support

---

## Running with Docker

### Quick Start

```bash
docker compose up -d
```

Then open `http://localhost:5000` in your browser.

### Building manually

```bash
docker build -t polymarket-bot .
docker run -d \
  -p 5000:5000 \
  -v polybot-data:/data \
  --name polybot \
  polymarket-bot
```

---

## Unraid Setup

### Method 1: Docker Compose (recommended)

1. Install the **Community Applications** plugin if you haven't already
2. Install the **Compose Manager** plugin from Community Applications
3. Create a new compose stack and paste in the contents of `docker-compose.yml`
4. Click **Deploy**

### Method 2: Unraid Docker UI (manual)

1. In the Unraid UI go to **Docker → Add Container**
2. Fill in:
   | Field | Value |
   |---|---|
   | Name | `polybot` |
   | Repository | `ghcr.io/emdoc12/polymarket-bot:latest` *(or build locally)* |
   | Network Type | Bridge |
   | Port Mapping | Host `5000` → Container `5000` |
   | Path Mapping | Host `/mnt/user/appdata/polybot` → Container `/data` |
3. Add environment variables (see below)
4. Click **Apply**

### Updating

When this repo gets updates, pull the latest image and restart:

```bash
docker compose pull && docker compose up -d
```

Or in Unraid: go to Docker, click the container, and choose **Update**.

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `NODE_ENV` | Yes | Set to `production` |
| `DATA_DIR` | No | Path to SQLite data directory (default: `/data`) |
| `POLY_PRIVATE_KEY` | Live mode only | Your Polygon wallet private key |
| `POLY_API_KEY` | Live mode only | Polymarket CLOB L2 API key |
| `POLY_API_SECRET` | Live mode only | Polymarket CLOB L2 API secret |
| `POLY_PASSPHRASE` | Live mode only | Polymarket CLOB L2 passphrase |

---

## Enabling Live Trading

Live trading requires a Polygon wallet with USDC and Polymarket CLOB API credentials.

1. **Get USDC on Polygon** — Bridge USDC to the Polygon network
2. **Approve on Polymarket** — Visit [polymarket.com](https://polymarket.com) and connect your wallet to approve the CLOB contract
3. **Derive L2 credentials** — Use the official SDK:

```python
# Using py-clob-client
from py_clob_client.client import ClobClient
from py_clob_client.constants import POLYGON

client = ClobClient("https://clob.polymarket.com", key=PRIVATE_KEY, chain_id=POLYGON)
creds = client.create_or_derive_api_creds()
print(creds)  # Save API_KEY, API_SECRET, PASSPHRASE
```

4. **Set environment variables** in `docker-compose.yml` and switch to **Live Mode** in the app's Settings page.

> ⚠️ **Warning:** Live mode executes real transactions. Always test thoroughly in Paper mode first. Never commit your private key to git.

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

All data (strategies, trade logs, watchlist, settings) is stored in a SQLite database at `/data/data.db` inside the container. Mount a host volume to persist data across container restarts.
