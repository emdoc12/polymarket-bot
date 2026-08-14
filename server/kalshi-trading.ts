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
const KALSHI_DEMO_API = process.env.KALSHI_DEMO_API_BASE || "https://demo-api.kalshi.co";
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
export function getKalshiCredentials(): KalshiCredentials | null {
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

async function kalshiPrivateFetch(
  method: "GET" | "POST" | "DELETE",
  endpointPath: string,
  body?: unknown,
) {
  const creds = getKalshiCredentials();
  if (!creds) {
    throw new Error("Kalshi API credentials not configured (need key id + private key PEM)");
  }
  const requestPath = `${API_PREFIX}${endpointPath}`;
  const timestampMs = String(Date.now());
  const signature = signKalshiRequest(creds.privateKeyPem, timestampMs, method, requestPath);
  const res = await fetch(`${KALSHI_DEMO_API}${requestPath}`, {
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
    throw new Error(`Kalshi demo API ${res.status}: ${detail}`);
  }
  return json;
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
};

function buildOrderPayload(order: KalshiOrderRequest) {
  if (!order.ticker || typeof order.ticker !== "string") throw new Error("ticker required");
  if (order.side !== "yes" && order.side !== "no") throw new Error("side must be yes|no");
  if (order.action !== "buy" && order.action !== "sell") throw new Error("action must be buy|sell");
  if (order.type !== "limit" && order.type !== "market") throw new Error("type must be limit|market");
  const count = Math.floor(order.count);
  if (!Number.isFinite(count) || count <= 0) throw new Error("count must be a positive integer");

  const payload: Record<string, unknown> = {
    ticker: order.ticker,
    side: order.side,
    action: order.action,
    count,
    type: order.type,
    client_order_id: crypto.randomUUID(),
  };
  if (order.type === "limit") {
    const cents = order.side === "yes" ? order.yesPriceCents : order.noPriceCents;
    if (cents == null || !Number.isInteger(cents) || cents < 1 || cents > 99) {
      throw new Error(`${order.side}PriceCents (1-99) required for limit orders`);
    }
    if (order.side === "yes") payload.yes_price = cents;
    else payload.no_price = cents;
  }
  if (order.type === "market" && order.action === "buy" && order.buyMaxCostCents != null) {
    payload.buy_max_cost = Math.floor(order.buyMaxCostCents);
  }
  return payload;
}

// Ring buffer of intended orders while in dry-run mode, so strategy behavior
// against demo is inspectable before any order is ever transmitted.
const dryRunLog: { at: string; payload: Record<string, unknown> }[] = [];
const DRY_RUN_LOG_MAX = 200;

export async function placeKalshiOrder(order: KalshiOrderRequest) {
  const payload = buildOrderPayload(order);
  if (isKalshiDryRun()) {
    dryRunLog.unshift({ at: new Date().toISOString(), payload });
    if (dryRunLog.length > DRY_RUN_LOG_MAX) dryRunLog.length = DRY_RUN_LOG_MAX;
    return { dryRun: true, wouldSend: payload, env: "demo" };
  }
  const response = await kalshiPrivateFetch("POST", "/portfolio/orders", payload);
  return { dryRun: false, order: response?.order ?? response, env: "demo" };
}

export async function cancelKalshiOrder(orderId: string) {
  return kalshiPrivateFetch("DELETE", `/portfolio/orders/${encodeURIComponent(orderId)}`);
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
  const creds = getKalshiCredentials();
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
    const balance = await getKalshiBalance();
    liveProbe = `ok: balance=${JSON.stringify(balance)}`;
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
