// Free, no-key market data. Stooq (CSV) is primary — it's permissive from
// datacenter IPs; Yahoo (JSON) is the fallback. Daily closes only (enough for
// multi-day correlation). In-memory cache keeps the Market tab and worker tick
// from hammering the feeds.
import { findInstrument } from "./catalog.js";

export interface Candles {
  symbol: string;
  closes: number[]; // chronological, most recent LAST
  asOf: string; // ISO date of the latest close
  source: "stooq" | "yahoo" | "none";
}

const CACHE = new Map<string, { data: Candles; t: number }>();
const TTL_MS = 10 * 60 * 1000; // 10 min

async function fetchStooq(stooq: string): Promise<{ closes: number[]; asOf: string } | null> {
  try {
    // Full daily history; we only keep the tail. e=csv, i=d (daily).
    const res = await fetch(`https://stooq.com/q/d/l/?s=${encodeURIComponent(stooq)}&i=d`, {
      headers: { "user-agent": "Mozilla/5.0 EREBUS" },
    });
    if (!res.ok) return null;
    const text = await res.text();
    const lines = text.trim().split(/\r?\n/);
    if (lines.length < 2 || !/date/i.test(lines[0] ?? "")) return null; // "N/D" or error body
    const rows = lines.slice(1).map((l) => l.split(","));
    const closes: number[] = [];
    let asOf = "";
    for (const r of rows) {
      const close = Number(r[4]); // Date,Open,High,Low,Close,Volume
      if (Number.isFinite(close) && close > 0) {
        closes.push(close);
        asOf = r[0] ?? asOf;
      }
    }
    if (closes.length < 2) return null;
    return { closes: closes.slice(-90), asOf };
  } catch {
    return null;
  }
}

async function fetchYahoo(yahoo: string): Promise<{ closes: number[]; asOf: string } | null> {
  try {
    const res = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahoo)}?range=3mo&interval=1d`,
      { headers: { "user-agent": "Mozilla/5.0 EREBUS" } }
    );
    if (!res.ok) return null;
    const j = (await res.json()) as {
      chart?: { result?: Array<{ timestamp?: number[]; indicators?: { quote?: Array<{ close?: (number | null)[] }> } }> };
    };
    const r = j.chart?.result?.[0];
    const raw = r?.indicators?.quote?.[0]?.close ?? [];
    const ts = r?.timestamp ?? [];
    const closes: number[] = [];
    let lastTs = 0;
    raw.forEach((c, i) => {
      if (typeof c === "number" && Number.isFinite(c) && c > 0) {
        closes.push(c);
        lastTs = ts[i] ?? lastTs;
      }
    });
    if (closes.length < 2) return null;
    const asOf = lastTs ? new Date(lastTs * 1000).toISOString().slice(0, 10) : "";
    return { closes: closes.slice(-90), asOf };
  } catch {
    return null;
  }
}

export async function fetchCandles(symbol: string): Promise<Candles> {
  const cached = CACHE.get(symbol);
  if (cached && Date.now() - cached.t < TTL_MS) return cached.data;

  const inst = findInstrument(symbol);
  if (!inst) return { symbol, closes: [], asOf: "", source: "none" };

  let data: Candles = { symbol, closes: [], asOf: "", source: "none" };
  const s = await fetchStooq(inst.stooq);
  if (s) data = { symbol, closes: s.closes, asOf: s.asOf, source: "stooq" };
  else {
    const y = await fetchYahoo(inst.yahoo);
    if (y) data = { symbol, closes: y.closes, asOf: y.asOf, source: "yahoo" };
  }

  if (data.closes.length) CACHE.set(symbol, { data, t: Date.now() });
  return data;
}

// % change over the last `tradingDays` closes (latest vs N-back). Null if short.
export function changePct(closes: number[], tradingDays: number): number | null {
  if (closes.length < 2) return null;
  const last = closes[closes.length - 1]!;
  const idx = Math.max(0, closes.length - 1 - tradingDays);
  const prev = closes[idx]!;
  if (!prev) return null;
  return ((last - prev) / prev) * 100;
}

export interface Quote {
  symbol: string;
  price: number | null;
  asOf: string;
  source: string;
  d1: number | null; // 1-day %
  d5: number | null; // ~1-week %
  d30: number | null; // ~1-month %
}

export async function getQuote(symbol: string): Promise<Quote> {
  const c = await fetchCandles(symbol);
  const price = c.closes.length ? c.closes[c.closes.length - 1]! : null;
  return {
    symbol,
    price,
    asOf: c.asOf,
    source: c.source,
    d1: changePct(c.closes, 1),
    d5: changePct(c.closes, 5),
    d30: changePct(c.closes, 22),
  };
}
