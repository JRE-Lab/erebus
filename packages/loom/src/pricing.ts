// ============================================================================
// LOOM Phase 2 — daily OHLCV via Yahoo chart API (free, no key; the same host
// @erebus/market already uses successfully from the VPS). Universe = every
// instrument in loom_instruments plus the benchmarks (SPY for the market
// model, ^VIX for the regime conditioner). History upserts so late
// corrections and fresh listings converge.
// ============================================================================
import { eq, sql } from "drizzle-orm";
import { db, loomInstruments, loomPrices } from "@erebus/db";
import { ensureInstrument } from "./entities.js";

// The refetch window must cover EVERY row we keep, because Yahoo back-adjusts
// the whole requested range for splits/dividends: refetching a shorter window
// than the stored history leaves older rows on a stale adjustment basis and
// manufactures a fake jump at the seam. 5y comfortably covers the 120-day
// estimation window plus a full rate cycle; rows older than this are pruned.
const HISTORY_RANGE = process.env.LOOM_PRICE_RANGE || "5y";
const KEEP_DAYS = Number(process.env.LOOM_PRICE_KEEP_DAYS || 1900); // ~5y of calendar days
const REFRESH_BATCH = Number(process.env.LOOM_PRICE_BATCH || 60); // symbols per pass

export const BENCHMARKS = [
  { symbol: "SPY", kind: "etf", name: "S&P 500 (market model benchmark)" },
  { symbol: "^VIX", kind: "index", name: "CBOE VIX (regime conditioner)" },
];

interface Bar { date: string; open: number | null; high: number | null; low: number | null; close: number; volume: number | null }

// Today's bar is still forming — its "close" is the last trade, not the close.
// Storing it would let an event-study window finalize on a partial day (and
// event studies never recompute once car_post is non-null), so it is dropped.
function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

async function yahooHistory(symbol: string): Promise<Bar[]> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${HISTORY_RANGE}&interval=1d`;
  const res = await fetch(url, {
    headers: { "user-agent": "Mozilla/5.0" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`yahoo ${res.status}: ${symbol}`);
  const j = (await res.json()) as {
    chart?: {
      result?: Array<{
        timestamp?: number[];
        indicators?: {
          quote?: Array<{ open?: Array<number | null>; high?: Array<number | null>; low?: Array<number | null>; close?: Array<number | null>; volume?: Array<number | null> }>;
          adjclose?: Array<{ adjclose?: Array<number | null> }>;
        };
      }>;
    };
  };
  const r0 = j.chart?.result?.[0];
  const ts = r0?.timestamp ?? [];
  const q = r0?.indicators?.quote?.[0];
  // TOTAL-RETURN series: quote.close is split- but NOT dividend-adjusted, so
  // every ex-date injects a spurious negative return of the dividend's size —
  // the same order of magnitude as the abnormal drift M5 exists to detect.
  // adjclose is the spec's required basis; quote.close is the fallback only.
  const adj = r0?.indicators?.adjclose?.[0]?.adjclose;
  const today = todayUtc();
  const bars: Bar[] = [];
  for (let i = 0; i < ts.length; i++) {
    const raw = q?.close?.[i];
    const close = adj?.[i] ?? raw;
    if (close == null || !Number.isFinite(close)) continue; // holiday/null rows
    const date = new Date(ts[i]! * 1000).toISOString().slice(0, 10);
    if (date >= today) continue; // in-progress bar — never store a partial day
    bars.push({
      date,
      open: q?.open?.[i] ?? null,
      high: q?.high?.[i] ?? null,
      low: q?.low?.[i] ?? null,
      close,
      volume: q?.volume?.[i] ?? null,
    });
  }
  return bars;
}

export interface LoomPriceResult {
  instruments: number;
  barsUpserted: number;
  errors: string[];
}

// Refresh price history for the stalest instruments first (fair rotation when
// the universe outgrows the per-pass batch). Free HTTP only.
export async function refreshLoomPrices(): Promise<LoomPriceResult> {
  const r: LoomPriceResult = { instruments: 0, barsUpserted: 0, errors: [] };

  for (const b of BENCHMARKS) await ensureInstrument(b.symbol, b.kind, b.name);

  const targets = await db.execute(sql`
    SELECT i.id, i.symbol,
           (SELECT max(p.date) FROM loom_prices p WHERE p.instrument_id = i.id) AS latest
      FROM loom_instruments i
     ORDER BY latest ASC NULLS FIRST
     LIMIT ${REFRESH_BATCH}
  `);

  const cutoff = new Date(Date.now() - KEEP_DAYS * 86_400_000).toISOString().slice(0, 10);

  for (const t of (targets as unknown as { rows: Array<Record<string, unknown>> }).rows) {
    try {
      const bars = (await yahooHistory(t.symbol as string)).filter((b) => b.date >= cutoff);
      // Chunked multi-row upsert: a full-history refetch is thousands of bars,
      // and one round-trip each would dominate the pass.
      for (let i = 0; i < bars.length; i += 500) {
        const chunk = bars.slice(i, i + 500);
        await db
          .insert(loomPrices)
          .values(
            chunk.map((bar) => ({
              instrumentId: t.id as string,
              date: bar.date,
              open: bar.open,
              high: bar.high,
              low: bar.low,
              close: bar.close,
              volume: bar.volume,
            }))
          )
          .onConflictDoUpdate({
            target: [loomPrices.instrumentId, loomPrices.date],
            set: {
              close: sql`excluded.close`,
              volume: sql`excluded.volume`,
              open: sql`excluded.open`,
              high: sql`excluded.high`,
              low: sql`excluded.low`,
            },
          });
      }
      r.instruments++;
      r.barsUpserted += bars.length;
      await new Promise((res2) => setTimeout(res2, 300)); // be polite to the free host
    } catch (e) {
      r.errors.push(`${t.symbol}: ${(e as Error).message.slice(0, 60)}`);
    }
  }

  return r;
}

// Close series for one symbol, ascending by date. Used by events/positioning.
export async function priceSeries(symbol: string): Promise<Array<{ date: string; close: number; volume: number | null }>> {
  const res = await db.execute(sql`
    SELECT p.date::text AS date, p.close, p.volume
      FROM loom_prices p JOIN loom_instruments i ON i.id = p.instrument_id
     WHERE i.symbol = ${symbol}
     ORDER BY p.date ASC
  `);
  return (res as unknown as { rows: Array<Record<string, unknown>> }).rows.map((r2) => ({
    date: r2.date as string,
    close: Number(r2.close),
    volume: r2.volume == null ? null : Number(r2.volume),
  }));
}
