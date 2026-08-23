// ============================================================================
// LOOM Phase 2 — event studies (spec M5 event-study block). For each promoted
// narrative x linked instrument: market model r_i = alpha + beta * r_m (OLS,
// benchmark SPY) estimated over <=120 trading days ending T-11, where T = the
// narrative's first-seen date (R1 — never the claimed publish date). CARs:
// pre [-10,-1], event [0,+1], drift [+2,+10]; windows that haven't closed yet
// stay NULL and are upserted on later passes. Pure math over stored prices.
// ============================================================================
import { sql } from "drizzle-orm";
import { db, loomEventStudies } from "@erebus/db";
import { narrativeInstruments } from "./entities.js";
import { priceSeries } from "./pricing.js";

const MIN_ESTIMATION_DAYS = 60;
const ESTIMATION_DAYS = 120;

function returns(closes: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < closes.length; i++) out.push(closes[i]! / closes[i - 1]! - 1);
  return out;
}

// OLS of y on x -> {alpha, beta}
function ols(y: number[], x: number[]): { alpha: number; beta: number } {
  const n = Math.min(y.length, x.length);
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) {
    sx += x[i]!; sy += y[i]!; sxx += x[i]! * x[i]!; sxy += x[i]! * y[i]!;
  }
  const denom = n * sxx - sx * sx;
  const beta = denom === 0 ? 0 : (n * sxy - sx * sy) / denom;
  const alpha = (sy - beta * sx) / n;
  return { alpha, beta };
}

export interface LoomEventStudyResult {
  computed: number;
  pending: number; // rows written but with unclosed post windows
  skipped: number; // insufficient history
}

export async function runEventStudies(): Promise<LoomEventStudyResult> {
  const r: LoomEventStudyResult = { computed: 0, pending: 0, skipped: 0 };

  // Narratives needing a (re)computation: no row yet, or car_post still NULL.
  const targets = await db.execute(sql`
    SELECT n.id, n.seeded_at::date::text AS event_date
      FROM loom_narratives n
     WHERE n.promoted_at IS NOT NULL
       AND (
         NOT EXISTS (SELECT 1 FROM loom_event_studies s WHERE s.narrative_id = n.id)
         OR EXISTS (SELECT 1 FROM loom_event_studies s WHERE s.narrative_id = n.id AND s.car_post IS NULL)
       )
     ORDER BY n.last_seen_at DESC
     LIMIT 10
  `);

  const spy = await priceSeries("SPY");
  if (spy.length < MIN_ESTIMATION_DAYS) return { ...r, skipped: 1 };

  for (const t of (targets as unknown as { rows: Array<Record<string, unknown>> }).rows) {
    const narrativeId = t.id as string;
    const eventDate = t.event_date as string;
    const instruments = await narrativeInstruments(narrativeId);

    for (const inst of instruments.slice(0, 4)) {
      const series = await priceSeries(inst.symbol);
      if (series.length < MIN_ESTIMATION_DAYS) { r.skipped++; continue; }

      // Align on shared trading dates (instrument ∩ SPY).
      const spyByDate = new Map(spy.map((p) => [p.date, p.close]));
      const aligned = series.filter((p) => spyByDate.has(p.date));
      const dates = aligned.map((p) => p.date);

      // T index = first trading day >= event date.
      let ti = dates.findIndex((d) => d >= eventDate);
      if (ti === -1) { r.skipped++; continue; } // narrative newer than all data (prices stale)
      // Estimation window ENDS at T-11 inclusive (spec M5). iRet[k-1] is the
      // return realized on day k, so the slice below must run to estEnd, not
      // estEnd-1 — the old form ended at T-12 and silently dropped a day.
      const estEnd = ti - 11;
      if (estEnd < MIN_ESTIMATION_DAYS) { r.skipped++; continue; }
      const estStart = Math.max(1, estEnd - ESTIMATION_DAYS);

      const iCloses = aligned.map((p) => p.close);
      const mCloses = dates.map((d) => spyByDate.get(d)!);
      const iRet = returns(iCloses); // iRet[k] = return on day k+1
      const mRet = returns(mCloses);

      const yEst = iRet.slice(estStart - 1, estEnd); // returns on days estStart..T-11
      const xEst = mRet.slice(estStart - 1, estEnd);
      const { alpha, beta } = ols(yEst, xEst);
      const abnormal = (k: number): number | null => {
        // abnormal return on day index k (0-based in `dates`, needs k>=1)
        if (k < 1 || k >= dates.length) return null;
        return iRet[k - 1]! - (alpha + beta * mRet[k - 1]!);
      };
      const car = (from: number, to: number): number | null => {
        // sum abnormal returns for day offsets [from..to] relative to T
        let s = 0;
        for (let off = from; off <= to; off++) {
          const a = abnormal(ti + off);
          if (a == null) return null; // window not fully in data yet
          s += a;
        }
        return s;
      };

      const carPre = car(-10, -1);
      const carEvent = car(0, 1);
      // A CAR only finalizes once its whole window is in CLOSED trading days.
      // yahooHistory already drops the in-progress bar, so the last stored day
      // is complete; requiring it to sit past the window end keeps a drift CAR
      // from freezing on a truncated window (event studies never recompute
      // once car_post is non-null).
      const carPost = dates.length - 1 >= ti + 10 ? car(2, 10) : null;
      const modelMeta = {
        alpha: Number(alpha.toFixed(6)),
        beta: Number(beta.toFixed(4)),
        n: yEst.length,
        eventDate,
        eventTradingDay: dates[ti],
        symbol: inst.symbol,
      };

      await db
        .insert(loomEventStudies)
        .values({
          narrativeId,
          instrumentId: inst.instrumentId,
          carPre,
          carEvent,
          carPost,
          modelMeta,
        })
        .onConflictDoUpdate({
          target: [loomEventStudies.narrativeId, loomEventStudies.instrumentId],
          set: { carPre, carEvent, carPost, modelMeta, computedAt: sql`now()` },
        });
      if (carPost == null) r.pending++;
      else r.computed++;
    }
  }

  return r;
}
