import WebSocket from "ws";
import { fetchCfPassthrough, getKalshiCredentialsEnv, signKalshiRequest } from "./kalshi-trading";

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

// price in cents -> resting contracts in CENTI-CONTRACTS (integer). Kalshi
// sends fixed-point strings with 2 decimals; storing them as scaled integers
// keeps delta arithmetic exact - float accumulation left ~1e-12 residue that
// kept emptied "ghost" levels alive in the book.
type BookSide = Map<number, number>;

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

function centiContracts(s: unknown): number | null {
  const v = typeof s === "string" ? parseFloat(s) : typeof s === "number" ? s : NaN;
  if (!Number.isFinite(v)) return null;
  return Math.round(v * 100);
}

// Underlying settlement-index feed (CF Benchmarks via Kalshi's own WS).
// One rolling buffer per index of ~1s samples for strike capture, spot
// reads, and realized-vol estimates. Values are the actual index the
// markets settle on - not an exchange approximation.
type SpotSample = { ts: number; value: number };
type SpotBuffer = { samples: SpotSample[]; lastValue: number | null; lastTs: number; avg60s: number | null };

export const SERIES_INDEX: Record<string, string> = {
  KXBTC15M: "BRTI",
  KXETH15M: "ETHUSD_RTI",
};
const SPOT_BUFFER_MS = 40 * 60 * 1000;

class KalshiMarketStream {
  private ws: WebSocket | null = null;
  private books = new Map<string, MarketBook>();
  // Multiple consumers (shadow, live executor) declare interest separately;
  // the subscription is the union so neither clobbers the other.
  private wantedByOwner = new Map<string, Set<string>>();
  private wanted = new Set<string>();
  private subscribed = new Set<string>();
  private sid: number | null = null;
  private cfbenchSid: number | null = null;
  private lastSeqBySid = new Map<number, number>();
  private spot = new Map<string, SpotBuffer>();
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
    if (this.gapFillTimer) clearTimeout(this.gapFillTimer);
    this.gapFillTimer = null;
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
      spot: Object.fromEntries([...this.spot.entries()].map(([index, buf]) => [index, {
        value: buf.lastValue,
        ageMs: buf.lastTs ? Date.now() - buf.lastTs : null,
        avg60s: buf.avg60s,
        samples: buf.samples.length,
      }])),
    };
  }

  // ---- Spot (settlement index) accessors ----

  getSpot(series: string, maxAgeMs = 15_000): { value: number; ts: number; ageMs: number } | null {
    const buf = this.spot.get(SERIES_INDEX[series] ?? series);
    if (!buf || buf.lastValue == null) return null;
    const age = Date.now() - buf.lastTs;
    if (age > maxAgeMs) return null;
    return { value: buf.lastValue, ts: buf.lastTs, ageMs: age };
  }

  // Index value nearest a past timestamp (e.g. a window's open = the strike).
  getSpotAt(series: string, ts: number, toleranceMs = 90_000): number | null {
    const buf = this.spot.get(SERIES_INDEX[series] ?? series);
    if (!buf || buf.samples.length === 0) return null;
    let best: SpotSample | null = null;
    for (const s of buf.samples) {
      if (!best || Math.abs(s.ts - ts) < Math.abs(best.ts - ts)) best = s;
    }
    return best && Math.abs(best.ts - ts) <= toleranceMs ? best.value : null;
  }

  // Realized volatility of the index as stddev of per-second log returns
  // over the lookback. Multiply by value*sqrt(seconds) for a move scale.
  getSpotVolPerSecond(series: string, lookbackMinutes: number): number | null {
    const buf = this.spot.get(SERIES_INDEX[series] ?? series);
    if (!buf) return null;
    const cutoff = Date.now() - lookbackMinutes * 60_000;
    const samples = buf.samples.filter((s) => s.ts >= cutoff);
    if (samples.length < 30) return null;
    const rets: number[] = [];
    for (let i = 1; i < samples.length; i++) {
      const dt = (samples[i].ts - samples[i - 1].ts) / 1000;
      if (dt <= 0 || dt > 10) continue;
      rets.push(Math.log(samples[i].value / samples[i - 1].value) / Math.sqrt(dt));
    }
    if (rets.length < 20) return null;
    const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
    const variance = rets.reduce((a, r) => a + (r - mean) ** 2, 0) / rets.length;
    return Math.sqrt(variance);
  }

  // Declare which markets an owner cares about; the subscription follows the
  // union across owners.
  setMarkets(tickers: string[], owner = "shadow") {
    this.wantedByOwner.set(owner, new Set(tickers));
    this.wanted = new Set<string>();
    for (const set of this.wantedByOwner.values()) {
      for (const t of set) this.wanted.add(t);
    }
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
      yesAskDepth: bestNoBidCents != null ? (book.no.get(bestNoBidCents) ?? 0) / 100 : 0,
      yesBidDepth: bestYesBidCents != null ? (book.yes.get(bestYesBidCents) ?? 0) / 100 : 0,
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
      this.cfbenchSid = null;
      this.lastSeqBySid.clear();
      this.subscribed.clear();
      console.log(`${new Date().toISOString()} [kalshi-ws] connected to ${host}`);
      this.syncSubscriptions();
      // Settlement-index feed: always on while connected - it is the
      // underlying truth every strategy family can price against. Subscribe
      // both rates: 5hz (Sep 2026 upgrade, free) for freshness, 1hz as the
      // fallback on indices where 5hz isn't supported; the ~1s sampler
      // dedupes whatever arrives.
      this.send({ cmd: "subscribe", params: { channels: ["cfbenchmarks_value_5hz"], index_ids: Object.values(SERIES_INDEX) } });
      this.send({ cmd: "subscribe", params: { channels: ["cfbenchmarks_value"], index_ids: Object.values(SERIES_INDEX) } });
      // Every restart used to blind the value model for ~30 min (empty vol
      // buffer, unknown strikes). Backfill from the history passthrough so
      // vol and strike capture are live within seconds of boot.
      void this.backfillSpotHistory();
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

  private backfilling = false;
  private gapFillTimer: ReturnType<typeof setTimeout> | null = null;
  private async backfillSpotHistory() {
    if (this.backfilling) return;
    this.backfilling = true;
    try {
      for (const indexId of Object.values(SERIES_INDEX)) {
        const buf = this.spot.get(indexId) ?? { samples: [], lastValue: null, lastTs: 0, avg60s: null };
        const fetched: SpotSample[] = [];
        for (const hoursBack of [1, 0]) {
          try {
            const hourStart = (Math.floor(Date.now() / 3600_000) - hoursBack) * 3600_000;
            const iso = new Date(hourStart).toISOString();
            const { samples } = await fetchCfPassthrough("prod", "history/values",
              `id=${encodeURIComponent(indexId)}&timespan=HOUR&timestamp=${encodeURIComponent(iso)}`);
            for (const s of samples) fetched.push({ ts: s.ts, value: s.value });
          } catch { /* partial backfill still helps */ }
        }
        if (fetched.length === 0) continue;
        // Sorted union with the live buffer, ~1s spacing. History lags up to
        // 15 min behind real time, so the connect-time pass leaves a hole
        // before the first live sample; the delayed second pass fills it.
        const cutoff = Date.now() - SPOT_BUFFER_MS;
        const before = buf.samples.length;
        const all = [...buf.samples, ...fetched.filter((s) => s.ts >= cutoff)].sort((a, b) => a.ts - b.ts);
        const merged: SpotSample[] = [];
        for (const s of all) {
          if (merged.length === 0 || s.ts - merged[merged.length - 1].ts >= 900) merged.push(s);
        }
        buf.samples = merged;
        if (buf.lastValue == null && merged.length > 0) {
          const newest = merged[merged.length - 1];
          buf.lastValue = newest.value;
          buf.lastTs = newest.ts;
        }
        this.spot.set(indexId, buf);
        console.log(`${new Date().toISOString()} [kalshi-ws] spot backfill ${indexId}: ${before} -> ${merged.length} samples`);
      }
    } finally {
      this.backfilling = false;
    }
    // Second pass once the upstream lag has passed, to close the boot hole.
    if (!this.gapFillTimer && !this.stopped) {
      this.gapFillTimer = setTimeout(() => {
        this.gapFillTimer = null;
        if (!this.stopped) void this.backfillSpotHistory();
      }, 12 * 60_000);
    }
  }

  private teardown(reason: string) {
    if (this.ws) {
      try { this.ws.removeAllListeners(); this.ws.close(); } catch { /* already closed */ }
      this.ws = null;
    }
    for (const book of this.books.values()) book.ready = false;
    this.subscribed.clear();
    this.sid = null;
    this.cfbenchSid = null;
    this.lastSeqBySid.clear();
    // Spot buffers survive reconnects: values are absolute (no delta state)
    // and strike capture needs continuity; staleness gates handle gaps.
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
    // A subscription change can restart the sid's seq numbering (observed as
    // spurious "gaps" at every window rotation). Re-anchor on the next
    // message instead of tearing the connection down.
    if ((toAdd.length > 0 || toDrop.length > 0) && this.sid != null) this.lastSeqBySid.delete(this.sid);
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
      const channel = parsed.msg?.channel;
      const sid = parsed.msg?.sid ?? parsed.sid ?? null;
      if (channel === "cfbenchmarks_value" || channel === "cfbenchmarks_value_5hz") {
        this.cfbenchSid = sid;
      } else {
        this.sid = sid;
        for (const t of this.wanted) this.subscribed.add(t);
      }
      return;
    }

    if (type === "cfbenchmarks_value" || type === "cfbenchmarks_value_5hz") {
      const msg = parsed.msg ?? {};
      const indexId: string | undefined = msg.index_id;
      if (!indexId) return;
      // Live value from the raw CF frame when parseable; the trailing 60s
      // average (always present, and literally the settlement statistic)
      // as fallback and side-channel.
      let value: number | null = null;
      try {
        const frame = typeof msg.data === "string" ? JSON.parse(msg.data) : msg.data;
        const rawVal = frame?.value ?? frame?.price ?? frame?.v;
        const parsedVal = typeof rawVal === "string" ? parseFloat(rawVal) : typeof rawVal === "number" ? rawVal : NaN;
        if (Number.isFinite(parsedVal) && parsedVal > 0) value = parsedVal;
      } catch { /* fall through to avg60s */ }
      const avgRaw = msg.avg_60s_data?.value;
      const avg60s = typeof avgRaw === "string" ? parseFloat(avgRaw) : typeof avgRaw === "number" ? avgRaw : NaN;
      if (value == null && Number.isFinite(avg60s) && avg60s > 0) value = avg60s;
      if (value == null) return;

      const ts = typeof msg.received_at === "number" ? msg.received_at : Date.now();
      const buf = this.spot.get(indexId) ?? { samples: [], lastValue: null, lastTs: 0, avg60s: null };
      buf.lastValue = value;
      buf.lastTs = ts;
      if (Number.isFinite(avg60s) && avg60s > 0) buf.avg60s = avg60s;
      // Sample at ~1s resolution regardless of feed rate.
      const lastSample = buf.samples[buf.samples.length - 1];
      if (!lastSample || ts - lastSample.ts >= 900) {
        buf.samples.push({ ts, value });
        const cutoff = ts - SPOT_BUFFER_MS;
        while (buf.samples.length > 0 && buf.samples[0].ts < cutoff) buf.samples.shift();
      }
      this.spot.set(indexId, buf);
      return;
    }
    if (type === "error") {
      this.lastError = `ws error code ${parsed.msg?.code}: ${parsed.msg?.msg ?? ""}`;
      console.error(`${new Date().toISOString()} [error] [kalshi-ws] ${this.lastError}`);
      return;
    }

    if (type === "orderbook_snapshot" || type === "orderbook_delta") {
      // Sequence check per subscription: deltas must arrive with no gaps.
      // A snapshot resets the counter for its sid.
      const seq = typeof parsed.seq === "number" ? parsed.seq : null;
      const sid = typeof parsed.sid === "number" ? parsed.sid : this.sid ?? -1;
      if (seq != null) {
        const last = this.lastSeqBySid.get(sid);
        if (type === "orderbook_delta" && last != null && seq !== last + 1) {
          this.forceResync(`seq gap on sid ${sid}: expected ${last + 1}, got ${seq}`);
          return;
        }
        this.lastSeqBySid.set(sid, seq);
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
            const qty = centiContracts(level[1]);
            if (cents != null && qty != null && qty > 0) sideMap.set(cents, qty);
          }
        }
        this.books.set(ticker, book);
        return;
      }

      // orderbook_delta
      const book = this.books.get(ticker);
      if (!book || !book.ready) return; // snapshot not seen yet; ignore
      const cents = centsFromDollarStr(msg.price_dollars);
      const delta = centiContracts(msg.delta_fp);
      const side: "yes" | "no" | undefined = msg.side;
      if (cents == null || delta == null || (side !== "yes" && side !== "no")) return;
      const sideMap = side === "yes" ? book.yes : book.no;
      const next = (sideMap.get(cents) ?? 0) + delta;
      if (next > 0) sideMap.set(cents, next);
      else sideMap.delete(cents);
      book.lastUpdateMs = Date.now();
    }
  }
}

export const kalshiProdStream = new KalshiMarketStream();
