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
| `POLY_PRIVATE_KEY` | Live mode only | Your Polygon wallet private key |
| `POLY_API_KEY` | Live mode only | Polymarket CLOB L2 API key |
| `POLY_API_SECRET` | Live mode only | Polymarket CLOB L2 API secret |
| `POLY_PASSPHRASE` | Live mode only | Polymarket CLOB L2 passphrase |

---

## Enabling Live Trading

Live trading requires a Polygon wallet with USDC and Polymarket CLOB API credentials.

1. **Get USDC on Polygon** — Bridge USDC to the Polygon network
2. **Approve on Polymarket** — Visit [polymarket.com](https://polymarket.com) and connect your wallet
3. **Derive L2 credentials** using the official SDK:

```python
from py_clob_client.client import ClobClient
from py_clob_client.constants import POLYGON

client = ClobClient("https://clob.polymarket.com", key=PRIVATE_KEY, chain_id=POLYGON)
creds = client.create_or_derive_api_creds()
print(creds)  # Save API_KEY, API_SECRET, PASSPHRASE
```

4. Add credentials to your `docker-compose.yml` and switch to **Live Mode** in Settings.

> ⚠️ **Warning:** Live mode executes real transactions. Always test in Paper mode first. Never commit your private key to git.

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
