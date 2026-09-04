import type { Express } from "express";
import crypto from "crypto";
import { readFileSync, existsSync } from "fs";
import path from "path";
import { storage } from "./storage";

// Phase 2: authenticated Kalshi client for the DEMO environment.
//
// Order and portfolio calls are hard-coded to the demo host in this build.
// Production order placement is intentionally not reachable from here — that
// is a Phase 3 decision the user makes explicitly, with real money on the
// line. Public market data (server/kalshi.ts) already reads from production
// because prices there are the real ones worth validating against.
// 2026-08-14: Kalshi retired external-api.demo.kalshi.co (410 "switch to V2
// endpoints", then 503s); demo-api.kalshi.co is the serving demo host. Same
// /trade-api/v2 prefix and signing scheme. Overridable without a rebuild.
//
// Phase 3 (2026-09-04): the same client is env-parameterized so the live
// executor can trade the PRODUCTION exchange with separate credentials while
// the demo pipeline keeps running unchanged. Demo-named exports remain and
// delegate with env="demo".
export type KalshiEnv = "demo" | "prod";
const API_BASES: Record<KalshiEnv, string> = {
  demo: process.env.KALSHI_DEMO_API_BASE || "https://demo-api.kalshi.co",
  prod: process.env.KALSHI_PROD_API_BASE || "https://external-api.kalshi.com",
};
const KALSHI_DEMO_API = API_BASES.demo;
const API_PREFIX = "/trade-api/v2";

type KalshiCredentials = {
  keyId: string;
  privateKeyPem: string;
  source: string;
};

// Key material resolution order:
//   1. KALSHI_API_KEY_ID + KALSHI_PRIVATE_KEY (PEM inline) env vars
//   2. KALSHI_API_KEY_ID + KALSHI_PRIVATE_KEY_PATH env vars
//   3. kalshi_api_key_id + kalshi_private_key_pem settings (Settings page UI)
//   4. kalshi_api_key_id setting + $DATA_DIR/kalshi-api-key.pem file
// The recommended path is 3: paste both values into the app's Settings page.
export function getKalshiCredentialsEnv(env: KalshiEnv): KalshiCredentials | null {
  if (env === "prod") {
    const keyId = process.env.KALSHI_PROD_API_KEY_ID || storage.getSetting("kalshi_prod_api_key_id");
    if (!keyId) return null;
    if (process.env.KALSHI_PROD_PRIVATE_KEY) {
      return { keyId, privateKeyPem: process.env.KALSHI_PROD_PRIVATE_KEY, source: "env:KALSHI_PROD_PRIVATE_KEY" };
    }
    const settingPem = storage.getSetting("kalshi_prod_private_key_pem");
    if (settingPem) return { keyId, privateKeyPem: settingPem, source: "settings" };
    const pemPath = process.env.KALSHI_PROD_PRIVATE_KEY_PATH;
    if (pemPath && existsSync(pemPath)) {
      return { keyId, privateKeyPem: readFileSync(pemPath, "utf8"), source: `file:${pemPath}` };
    }
    return null;
  }

  const envKeyId = process.env.KALSHI_API_KEY_ID;
  const settingKeyId = storage.getSetting("kalshi_api_key_id");
  const keyId = envKeyId || settingKeyId;
  if (!keyId) return null;

  if (process.env.KALSHI_PRIVATE_KEY) {
    return { keyId, privateKeyPem: process.env.KALSHI_PRIVATE_KEY, source: "env:KALSHI_PRIVATE_KEY" };
  }
  const settingPem = storage.getSetting("kalshi_private_key_pem");
  if (settingPem && !process.env.KALSHI_PRIVATE_KEY_PATH) {
    return { keyId, privateKeyPem: settingPem, source: "settings" };
  }
  const candidatePaths = [
    process.env.KALSHI_PRIVATE_KEY_PATH,
    process.env.DATA_DIR ? path.join(process.env.DATA_DIR, "kalshi-api-key.pem") : "kalshi-api-key.pem",
  ].filter((p): p is string => Boolean(p));
  for (const pemPath of candidatePaths) {
    try {
      if (existsSync(pemPath)) {
        return { keyId, privateKeyPem: readFileSync(pemPath, "utf8"), source: `file:${pemPath}` };
      }
    } catch {
      continue;
    }
  }
  return null;
}

export function getKalshiCredentials(): KalshiCredentials | null {
  return getKalshiCredentialsEnv("demo");
}

// Kalshi request signing: RSA-PSS over `timestampMs + METHOD + path`, where
// path includes the /trade-api/v2 prefix and excludes the query string.
// SHA-256 digest, MGF1-SHA-256, salt length = digest length.
export function signKalshiRequest(
  privateKeyPem: string,
  timestampMs: string,
  method: string,
  requestPath: string,
) {
  const message = `${timestampMs}${method}${requestPath}`;
  const signature = crypto.sign("sha256", Buffer.from(message, "utf8"), {
    key: privateKeyPem,
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
  });
  return signature.toString("base64");
}

export function isKalshiDryRun() {
  // Dry run stays on until the user flips it off AND credentials exist.
  return storage.getSetting("kalshi_dry_run") !== "false" || !getKalshiCredentials();
}

export async function kalshiPrivateFetchEnv(
  env: KalshiEnv,
  method: "GET" | "POST" | "DELETE",
  endpointPath: string,
  body?: unknown,
) {
  const creds = getKalshiCredentialsEnv(env);
  if (!creds) {
    throw new Error(`Kalshi ${env} API credentials not configured (need key id + private key PEM)`);
  }
  const requestPath = `${API_PREFIX}${endpointPath}`;
  const timestampMs = String(Date.now());
  const signature = signKalshiRequest(creds.privateKeyPem, timestampMs, method, requestPath);
  const res = await fetch(`${API_BASES[env]}${requestPath}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "KALSHI-ACCESS-KEY": creds.keyId,
      "KALSHI-ACCESS-TIMESTAMP": timestampMs,
      "KALSHI-ACCESS-SIGNATURE": signature,
    },
    body: body != null ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10000),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    const detail = json?.error?.message || json?.message || res.statusText;
    throw new Error(`Kalshi ${env} API ${res.status}: ${detail}`);
  }
  return json;
}

// Demo-bound wrapper: every pre-Phase-3 call site keeps its exact behavior.
export async function kalshiPrivateFetch(
  method: "GET" | "POST" | "DELETE",
  endpointPath: string,
  body?: unknown,
) {
  return kalshiPrivateFetchEnv("demo", method, endpointPath, body);
}

export async function getKalshiBalance() {
  return kalshiPrivateFetch("GET", "/portfolio/balance");
}

export async function getKalshiPositions() {
  return kalshiPrivateFetch("GET", "/portfolio/positions");
}

export async function getKalshiPortfolioOrders(status?: string) {
  const suffix = status ? `?status=${encodeURIComponent(status)}` : "";
  return kalshiPrivateFetch("GET", `/portfolio/orders${suffix}`);
}

export async function getKalshiFills() {
  return kalshiPrivateFetch("GET", "/portfolio/fills");
}

export type KalshiOrderRequest = {
  ticker: string;
  side: "yes" | "no";
  action: "buy" | "sell";
  count: number;
  type: "limit" | "market";
  yesPriceCents?: number;
  noPriceCents?: number;
  buyMaxCostCents?: number;
  // Pre-resolved demo exchange shard; looked up per-ticker when omitted.
  exchangeIndex?: number;
};

// Per Kalshi's exchange-sharding rollout (Aug 2026), collateral must be
// preallocated on a market's shard before orders are accepted there - a
// fresh shard even reports "user not found" until first funding. Returns the
// per-shard balances in dollars.
export async function getShardBalancesEnv(env: KalshiEnv): Promise<Map<number, number>> {
  const response = await kalshiPrivateFetchEnv(env, "GET", "/portfolio/balance");
  const balances = new Map<number, number>();
  for (const entry of response?.balance_breakdown ?? []) {
    const index = Number(entry?.exchange_index);
    const dollars = parseFloat(String(entry?.balance ?? ""));
    if (Number.isInteger(index) && Number.isFinite(dollars)) balances.set(index, dollars);
  }
  return balances;
}

// Ensure at least minDollars is available on the target shard, topping up
// from shard 0 when needed. Transfers are asynchronous on Kalshi's side, so
// after initiating one we poll briefly; if it hasn't landed by then, this
// window's order fails cleanly and the next window finds the funds waiting.
export async function getShardBalances(): Promise<Map<number, number>> {
  return getShardBalancesEnv("demo");
}

export async function ensureShardFunds(exchangeIndex: number, minDollars: number): Promise<void> {
  return ensureShardFundsEnv("demo", exchangeIndex, minDollars);
}

export async function ensureShardFundsEnv(env: KalshiEnv, exchangeIndex: number, minDollars: number): Promise<void> {
  if (exchangeIndex === 0) return;
  const balances = await getShardBalancesEnv(env);
  if ((balances.get(exchangeIndex) ?? 0) >= minDollars) return;

  const available = balances.get(0) ?? 0;
  // Move a chunk, not a trickle, so transfers stay rare.
  const amount = Math.min(Math.max(available - 1, 0), Math.max(100, minDollars * 5));
  if (amount < minDollars) {
    throw new Error(`insufficient shard-0 balance ($${available.toFixed(2)}) to fund shard ${exchangeIndex}`);
  }
  await kalshiPrivateFetchEnv(env, "POST", "/portfolio/intra_exchange_instance_transfer", {
    source: "event_contract",
    destination: "event_contract",
    amount: Math.round(amount * 10000), // centicents
    source_exchange_shard: 0,
    destination_exchange_shard: exchangeIndex,
  });
  console.log(`${new Date().toISOString()} [info] [kalshi] (${env}) transferring $${amount.toFixed(2)} shard 0 -> ${exchangeIndex}`);
  for (let attempt = 0; attempt < 4; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const refreshed = await getShardBalancesEnv(env);
    if ((refreshed.get(exchangeIndex) ?? 0) >= minDollars) return;
  }
  throw new Error(`shard ${exchangeIndex} funding still settling - will retry next window`);
}

// CreateOrder V2 (POST /portfolio/events/orders): single YES-leg order book
// with fixed-point dollar prices. Direction mapping per Kalshi's order-
// direction guide: bid = long YES, ask = long NO, and price is ALWAYS quoted
// on the YES scale - buying NO at 30c is an ask at 0.7000. The legacy
// /portfolio/orders endpoint now returns 410 on demo (retired 2026-08).
function buildOrderPayload(order: KalshiOrderRequest) {
  if (!order.ticker || typeof order.ticker !== "string") throw new Error("ticker required");
  if (order.side !== "yes" && order.side !== "no") throw new Error("side must be yes|no");
  if (order.action !== "buy") throw new Error("only buy orders are supported");
  if (order.type !== "limit") throw new Error("only limit orders are supported on the V2 path");
  const count = Math.floor(order.count);
  if (!Number.isFinite(count) || count <= 0) throw new Error("count must be a positive integer");

  const cents = order.side === "yes" ? order.yesPriceCents : order.noPriceCents;
  if (cents == null || !Number.isInteger(cents) || cents < 1 || cents > 99) {
    throw new Error(`${order.side}PriceCents (1-99) required for limit orders`);
  }
  const yesLegPrice = order.side === "yes" ? cents / 100 : (100 - cents) / 100;

  return {
    ticker: order.ticker,
    client_order_id: crypto.randomUUID(),
    side: order.side === "yes" ? "bid" : "ask",
    count: count.toFixed(2),
    price: yesLegPrice.toFixed(4),
    // IOC at our limit: fill whatever is available at or better than the
    // price right now, cancel the rest - matches the executor's fill-at-entry
    // semantics and never leaves resting orders behind.
    time_in_force: "immediate_or_cancel",
    self_trade_prevention_type: "taker_at_cross",
  };
}

// Ring buffer of intended orders while in dry-run mode, so strategy behavior
// against demo is inspectable before any order is ever transmitted.
const dryRunLog: { at: string; payload: Record<string, unknown> }[] = [];
const DRY_RUN_LOG_MAX = 200;

export type KalshiOrderResult =
  | { dryRun: true; wouldSend: Record<string, unknown>; env: string }
  | {
      dryRun: false;
      env: string;
      orderId: string | null;
      // Fixed-point strings from the V2 response, parsed for the caller.
      fillCount: number;
      averageFillPriceYesLeg: number | null;
      averageFeePaid: number | null;
    };

// The demo exchange mirrors production tickers but hosts them on its own
// exchange shards (e.g. crypto 15-min markets on exchange_index 2, while
// production uses 0). Orders defaulting to index 0 get "market not found" -
// so resolve the market's demo-side index right before placing.
export async function getMarketExchangeIndexEnv(env: KalshiEnv, ticker: string): Promise<number | null> {
  try {
    const res = await fetch(`${API_BASES[env]}${API_PREFIX}/markets/${encodeURIComponent(ticker)}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const data = await res.json() as { market?: { exchange_index?: number } };
    const index = data.market?.exchange_index;
    return Number.isInteger(index) ? (index as number) : null;
  } catch {
    return null;
  }
}

export async function getDemoMarketExchangeIndex(ticker: string): Promise<number | null> {
  return getMarketExchangeIndexEnv("demo", ticker);
}

export async function placeKalshiOrder(order: KalshiOrderRequest): Promise<KalshiOrderResult> {
  return placeKalshiOrderEnv("demo", order);
}

export async function placeKalshiOrderEnv(env: KalshiEnv, order: KalshiOrderRequest): Promise<KalshiOrderResult> {
  const payload = buildOrderPayload(order);
  // Dry-run is a demo-pipeline concept; the live executor's gates are
  // credentials + its own enable switch + kill switch.
  if (env === "demo" && isKalshiDryRun()) {
    dryRunLog.unshift({ at: new Date().toISOString(), payload });
    if (dryRunLog.length > DRY_RUN_LOG_MAX) dryRunLog.length = DRY_RUN_LOG_MAX;
    return { dryRun: true, wouldSend: payload, env: "demo" };
  }
  const exchangeIndex = order.exchangeIndex ?? await getMarketExchangeIndexEnv(env, order.ticker);
  if (exchangeIndex == null) {
    throw new Error(`market ${order.ticker} is not listed on the ${env} exchange`);
  }
  (payload as Record<string, unknown>).exchange_index = exchangeIndex;
  const response = await kalshiPrivateFetchEnv(env, "POST", "/portfolio/events/orders", payload);
  const parseFp = (value: unknown) => {
    const parsed = parseFloat(String(value ?? ""));
    return Number.isFinite(parsed) ? parsed : null;
  };
  return {
    dryRun: false,
    env,
    orderId: typeof response?.order_id === "string" ? response.order_id : null,
    fillCount: parseFp(response?.fill_count) ?? 0,
    averageFillPriceYesLeg: parseFp(response?.average_fill_price),
    averageFeePaid: parseFp(response?.average_fee_paid),
  };
}

export async function cancelKalshiOrder(orderId: string) {
  return kalshiPrivateFetch("DELETE", `/portfolio/orders/${encodeURIComponent(orderId)}`);
}

export async function getKalshiBalanceEnv(env: KalshiEnv) {
  return kalshiPrivateFetchEnv(env, "GET", "/portfolio/balance");
}

export function getKalshiAuthStatusEnv(env: KalshiEnv) {
  const creds = getKalshiCredentialsEnv(env);
  return { configured: Boolean(creds), keySource: creds?.source ?? null };
}

export function getKalshiAuthStatus() {
  const creds = getKalshiCredentials();
  return {
    configured: Boolean(creds),
    keyIdPresent: Boolean(creds?.keyId),
    keySource: creds?.source ?? null,
    env: "demo",
    prodOrders: "disabled_until_phase_3",
    dryRun: isKalshiDryRun(),
    dryRunLoggedOrders: dryRunLog.length,
  };
}

// Local sign/verify round-trip plus a live balance probe. With a throwaway
// key the probe should come back 401 (proves the signed request reaches
// Kalshi's auth layer); with a real demo key it returns the balance.
export async function runKalshiAuthSelfTest() {
  return runKalshiAuthSelfTestEnv("demo");
}

export async function runKalshiAuthSelfTestEnv(env: KalshiEnv) {
  const creds = getKalshiCredentialsEnv(env);
  if (!creds) {
    return { configured: false, localSignature: null, liveProbe: null };
  }
  let localSignature: string;
  try {
    const timestampMs = String(Date.now());
    const testPath = `${API_PREFIX}/portfolio/balance`;
    const signature = signKalshiRequest(creds.privateKeyPem, timestampMs, "GET", testPath);
    const publicKey = crypto.createPublicKey(creds.privateKeyPem);
    const verified = crypto.verify(
      "sha256",
      Buffer.from(`${timestampMs}GET${testPath}`, "utf8"),
      {
        key: publicKey,
        padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
        saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
      },
      Buffer.from(signature, "base64"),
    );
    localSignature = verified ? "ok" : "verify_failed";
  } catch (err) {
    return {
      configured: true,
      localSignature: `error: ${err instanceof Error ? err.message : String(err)}`,
      liveProbe: null,
    };
  }

  let liveProbe: string;
  try {
    const balance = await getKalshiBalanceEnv(env);
    // The API reports cents; show dollars so $50.00 doesn't read as "5000".
    liveProbe = typeof balance?.balance === "number"
      ? `ok: balance=$${(balance.balance / 100).toFixed(2)}`
      : `ok: balance=${JSON.stringify(balance)}`;
  } catch (err) {
    liveProbe = err instanceof Error ? err.message : String(err);
  }
  return { configured: true, localSignature, liveProbe };
}

export function registerKalshiTradingRoutes(app: Express) {
  app.get("/api/kalshi/auth/status", (_req, res) => {
    res.json(getKalshiAuthStatus());
  });

  app.post("/api/kalshi/auth/self-test", async (_req, res) => {
    try {
      res.json(await runKalshiAuthSelfTest());
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/kalshi/balance", async (_req, res) => {
    try {
      res.json(await getKalshiBalance());
    } catch (e: any) {
      res.status(502).json({ error: e.message });
    }
  });

  app.get("/api/kalshi/positions", async (_req, res) => {
    try {
      res.json(await getKalshiPositions());
    } catch (e: any) {
      res.status(502).json({ error: e.message });
    }
  });

  app.get("/api/kalshi/portfolio-orders", async (req, res) => {
    try {
      res.json(await getKalshiPortfolioOrders(req.query.status as string | undefined));
    } catch (e: any) {
      res.status(502).json({ error: e.message });
    }
  });

  app.get("/api/kalshi/fills", async (_req, res) => {
    try {
      res.json(await getKalshiFills());
    } catch (e: any) {
      res.status(502).json({ error: e.message });
    }
  });

  app.post("/api/kalshi/orders", async (req, res) => {
    try {
      const result = await placeKalshiOrder({
        ticker: req.body?.ticker,
        side: req.body?.side,
        action: req.body?.action,
        count: Number(req.body?.count),
        type: req.body?.type,
        yesPriceCents: req.body?.yesPriceCents != null ? Number(req.body.yesPriceCents) : undefined,
        noPriceCents: req.body?.noPriceCents != null ? Number(req.body.noPriceCents) : undefined,
        buyMaxCostCents: req.body?.buyMaxCostCents != null ? Number(req.body.buyMaxCostCents) : undefined,
      });
      res.json(result);
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  app.delete("/api/kalshi/orders/:orderId", async (req, res) => {
    try {
      res.json(await cancelKalshiOrder(req.params.orderId));
    } catch (e: any) {
      res.status(502).json({ error: e.message });
    }
  });

  app.get("/api/kalshi/dry-run-log", (_req, res) => {
    res.json({ dryRun: isKalshiDryRun(), orders: dryRunLog });
  });
}
