import WebSocket from "ws";
import { getKalshiCredentialsEnv, signKalshiRequest } from "./kalshi-trading";

// Streaming market data from Kalshi's WebSocket API (production).
//
// We subscribe to the orderbook_delta channel and maintain a local copy of
// each market's book: a snapshot arrives on subscribe, then seq-numbered
// deltas mutate it. If a seq gap is detected the local book is WRONG - we
// mark every book stale and force a full resubscribe rather than guess.
//
// This layer only produces quotes; it never places orders. The consumer
// (the WS shadow executor) treats a missing/stale book as "no data".

const WS_PATH = "/trade-api/ws/v2";
const PROD_WS_HOSTS = (process.env.KALSHI_PROD_WS_BASE
  ? [process.env.KALSHI_PROD_WS_BASE]
  : ["wss://external-api-ws.kalshi.com", "wss://api.elections.kalshi.com"]);

type BookSide = Map<number, number>; // price in cents -> resting contracts

type MarketBook = {
  yes: BookSide; // resting YES bids
  no: BookSide;  // resting NO bids (a NO bid at p == YES ask at 1-p)
  ready: boolean;
  lastUpdateMs: number;
};

export type StreamQuote = {
  yesBid: number | null;      // dollars
  yesAsk: number | null;      // dollars
  yesAskDepth: number;        // contracts resting at the best NO-bid level
  yesBidDepth: number;        // contracts resting at the best YES-bid level
  lastUpdateMs: number;
  ageMs: number;
};

function centsFromDollarStr(s: unknown): number | null {
  const v = typeof s === "string" ? parseFloat(s) : typeof s === "number" ? s : NaN;
  if (!Number.isFinite(v)) return null;
  return Math.round(v * 100);
}

class KalshiMarketStream {
  private ws: WebSocket | null = null;
  private books = new Map<string, MarketBook>();
  private wanted = new Set<string>();
  private subscribed = new Set<string>();
  private sid: number | null = null;
  private lastSeq: number | null = null;
  private cmdId = 1;
  private hostIndex = 0;
  private reconnectDelayMs = 1000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;

  // Diagnostics
  private connectedSince: number | null = null;
  private lastMessageMs = 0;
  private resyncs = 0;
  private disconnects = 0;
  private lastError: string | null = null;

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.teardown("stopped");
  }

  isConnected() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  status() {
    return {
      connected: this.isConnected(),
      host: PROD_WS_HOSTS[this.hostIndex % PROD_WS_HOSTS.length],
      connectedSince: this.connectedSince ? new Date(this.connectedSince).toISOString() : null,
      lastMessageAgoMs: this.lastMessageMs ? Date.now() - this.lastMessageMs : null,
      marketsSubscribed: [...this.subscribed],
      booksReady: [...this.books.values()].filter((b) => b.ready).length,
      resyncs: this.resyncs,
      disconnects: this.disconnects,
      lastError: this.lastError,
    };
  }

  // Declare which markets we care about; subscriptions follow.
  setMarkets(tickers: string[]) {
    this.wanted = new Set(tickers);
    for (const t of [...this.books.keys()]) {
      if (!this.wanted.has(t)) this.books.delete(t);
    }
    this.syncSubscriptions();
  }

  getQuote(ticker: string, maxAgeMs = 30_000): StreamQuote | null {
    const book = this.books.get(ticker);
    if (!book || !book.ready || !this.isConnected()) return null;
    const age = Date.now() - book.lastUpdateMs;
    if (age > maxAgeMs) return null;

    const bestYesBidCents = book.yes.size ? Math.max(...book.yes.keys()) : null;
    const bestNoBidCents = book.no.size ? Math.max(...book.no.keys()) : null;
    const yesBid = bestYesBidCents != null ? bestYesBidCents / 100 : null;
    const yesAsk = bestNoBidCents != null ? (100 - bestNoBidCents) / 100 : null;
    return {
      yesBid,
      yesAsk,
      yesAskDepth: bestNoBidCents != null ? (book.no.get(bestNoBidCents) ?? 0) : 0,
      yesBidDepth: bestYesBidCents != null ? (book.yes.get(bestYesBidCents) ?? 0) : 0,
      lastUpdateMs: book.lastUpdateMs,
      ageMs: age,
    };
  }

  private connect() {
    if (this.stopped) return;
    const creds = getKalshiCredentialsEnv("prod");
    if (!creds) {
      this.lastError = "prod credentials not configured";
      this.scheduleReconnect(15_000);
      return;
    }
    const host = PROD_WS_HOSTS[this.hostIndex % PROD_WS_HOSTS.length];
    const timestampMs = String(Date.now());
    let signature: string;
    try {
      signature = signKalshiRequest(creds.privateKeyPem, timestampMs, "GET", WS_PATH);
    } catch (err) {
      this.lastError = `signing failed: ${err instanceof Error ? err.message : String(err)}`;
      this.scheduleReconnect(30_000);
      return;
    }

    const ws = new WebSocket(`${host}${WS_PATH}`, {
      headers: {
        "KALSHI-ACCESS-KEY": creds.keyId,
        "KALSHI-ACCESS-TIMESTAMP": timestampMs,
        "KALSHI-ACCESS-SIGNATURE": signature,
      },
      handshakeTimeout: 10_000,
    });
    this.ws = ws;

    ws.on("open", () => {
      this.connectedSince = Date.now();
      this.lastMessageMs = Date.now();
      this.reconnectDelayMs = 1000;
      this.lastError = null;
      this.sid = null;
      this.lastSeq = null;
      this.subscribed.clear();
      console.log(`${new Date().toISOString()} [kalshi-ws] connected to ${host}`);
      this.syncSubscriptions();
    });
    // The ws library answers server pings with pongs automatically.
    ws.on("message", (data) => this.onMessage(data.toString()));
    ws.on("error", (err) => {
      this.lastError = err.message;
    });
    ws.on("close", (code) => {
      this.disconnects += 1;
      this.connectedSince = null;
      for (const book of this.books.values()) book.ready = false;
      if (!this.stopped) {
        // Rotate host on handshake-level failures (403/404 style closes
        // happen before any message arrives).
        if (this.lastMessageMs === 0 || Date.now() - this.lastMessageMs > 60_000) this.hostIndex += 1;
        console.error(`${new Date().toISOString()} [error] [kalshi-ws] closed (code ${code}${this.lastError ? `, ${this.lastError}` : ""}) - reconnecting`);
        this.scheduleReconnect();
      }
    });
  }

  private teardown(reason: string) {
    if (this.ws) {
      try { this.ws.removeAllListeners(); this.ws.close(); } catch { /* already closed */ }
      this.ws = null;
    }
    for (const book of this.books.values()) book.ready = false;
    this.subscribed.clear();
    this.sid = null;
    this.lastSeq = null;
    if (reason !== "stopped") this.resyncs += 1;
  }

  private scheduleReconnect(delayMs?: number) {
    if (this.stopped || this.reconnectTimer) return;
    const delay = delayMs ?? this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(60_000, this.reconnectDelayMs * 2);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private send(cmd: Record<string, unknown>) {
    if (!this.isConnected()) return;
    this.ws!.send(JSON.stringify({ id: this.cmdId++, ...cmd }));
  }

  private syncSubscriptions() {
    if (!this.isConnected()) return;
    const want = [...this.wanted];
    if (this.sid == null) {
      if (want.length === 0) return;
      this.send({ cmd: "subscribe", params: { channels: ["orderbook_delta"], market_tickers: want } });
      return;
    }
    const toAdd = want.filter((t) => !this.subscribed.has(t));
    const toDrop = [...this.subscribed].filter((t) => !this.wanted.has(t));
    if (toAdd.length > 0) {
      this.send({ cmd: "update_subscription", params: { sids: [this.sid], market_tickers: toAdd, action: "add_markets" } });
      for (const t of toAdd) this.subscribed.add(t);
    }
    if (toDrop.length > 0) {
      this.send({ cmd: "update_subscription", params: { sids: [this.sid], market_tickers: toDrop, action: "delete_markets" } });
      for (const t of toDrop) { this.subscribed.delete(t); this.books.delete(t); }
    }
  }

  private forceResync(reason: string) {
    console.error(`${new Date().toISOString()} [error] [kalshi-ws] resync (${reason}) - books discarded`);
    this.teardown(reason);
    this.scheduleReconnect(500);
  }

  private onMessage(raw: string) {
    this.lastMessageMs = Date.now();
    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    const type = parsed?.type;

    if (type === "subscribed") {
      this.sid = parsed.msg?.sid ?? parsed.sid ?? null;
      for (const t of this.wanted) this.subscribed.add(t);
      return;
    }
    if (type === "error") {
      this.lastError = `ws error code ${parsed.msg?.code}: ${parsed.msg?.msg ?? ""}`;
      console.error(`${new Date().toISOString()} [error] [kalshi-ws] ${this.lastError}`);
      return;
    }

    if (type === "orderbook_snapshot" || type === "orderbook_delta") {
      // Sequence check: deltas must arrive with no gaps. A snapshot resets
      // the counter (Kalshi numbers messages per subscription).
      const seq = typeof parsed.seq === "number" ? parsed.seq : null;
      if (seq != null) {
        if (type === "orderbook_delta" && this.lastSeq != null && seq !== this.lastSeq + 1) {
          this.forceResync(`seq gap: expected ${this.lastSeq + 1}, got ${seq}`);
          return;
        }
        this.lastSeq = seq;
      }
      const msg = parsed.msg ?? {};
      const ticker: string | undefined = msg.market_ticker;
      if (!ticker || !this.wanted.has(ticker)) return;

      if (type === "orderbook_snapshot") {
        const book: MarketBook = { yes: new Map(), no: new Map(), ready: true, lastUpdateMs: Date.now() };
        for (const [sideKey, sideMap] of [["yes_dollars_fp", book.yes], ["no_dollars_fp", book.no]] as const) {
          const levels = msg[sideKey];
          if (!Array.isArray(levels)) continue;
          for (const level of levels) {
            if (!Array.isArray(level) || level.length < 2) continue;
            const cents = centsFromDollarStr(level[0]);
            const qty = parseFloat(String(level[1]));
            if (cents != null && Number.isFinite(qty) && qty > 0) sideMap.set(cents, qty);
          }
        }
        this.books.set(ticker, book);
        return;
      }

      // orderbook_delta
      const book = this.books.get(ticker);
      if (!book || !book.ready) return; // snapshot not seen yet; ignore
      const cents = centsFromDollarStr(msg.price_dollars);
      const delta = parseFloat(String(msg.delta_fp));
      const side: "yes" | "no" | undefined = msg.side;
      if (cents == null || !Number.isFinite(delta) || (side !== "yes" && side !== "no")) return;
      const sideMap = side === "yes" ? book.yes : book.no;
      const next = (sideMap.get(cents) ?? 0) + delta;
      if (next > 0) sideMap.set(cents, next);
      else sideMap.delete(cents);
      book.lastUpdateMs = Date.now();
    }
  }
}

export const kalshiProdStream = new KalshiMarketStream();
