// ============================================================================
// LOOM M3 (Phase 2) — entity resolution graph. NER over promoted narratives
// (fast tier), aliases resolved to canonical entities, companies mapped to
// tickers via SEC company_tickers.json (free, no key), countries/commodities
// via static proxy-ETF maps. Exposure edges: direct 1.0, proxies 1.0.
// MVP cuts (documented in schema.ts): US-listed companies only, no sector/
// supply-chain edges, people/institutions v2.
// ============================================================================
import { eq, sql, and, isNotNull, isNull, desc } from "drizzle-orm";
import {
  db,
  loomNarratives,
  loomArticles,
  loomEntities,
  loomInstruments,
  loomExposures,
  loomNarrativeEntities,
} from "@erebus/db";
import { callJSON, loomEntityPrompt, SONNET } from "@erebus/agents";

const NER_BATCH = Number(process.env.LOOM_NER_BATCH || 5); // narratives per pass

// --- static proxy maps (spec M3: sovereign proxy = country ETF, commodity ETF)
const COUNTRY_ETF: Record<string, string> = {
  canada: "EWC", mexico: "EWW", china: "FXI", japan: "EWJ", germany: "EWG",
  "united kingdom": "EWU", uk: "EWU", britain: "EWU", france: "EWQ", italy: "EWI",
  spain: "EWP", brazil: "EWZ", india: "INDA", "south korea": "EWY", korea: "EWY",
  taiwan: "EWT", australia: "EWA", israel: "EIS", turkey: "TUR", "saudi arabia": "KSA",
  "south africa": "EZA", switzerland: "EWL", netherlands: "EWN", sweden: "EWD",
  poland: "EPOL", vietnam: "VNM", indonesia: "EIDO", thailand: "THD",
  malaysia: "EWM", philippines: "EPHE", chile: "ECH", colombia: "GXG",
  argentina: "ARGT", egypt: "EGPT", nigeria: "NGE", pakistan: "PAK", greece: "GREK",
  "united states": "SPY", usa: "SPY", ukraine: "SPY", russia: "SPY", iran: "USO",
  // Ukraine/Russia/Iran have no investable single-country ETF — nearest liquid
  // proxy (broad market / oil) with a low weight set below.
};
const WEAK_COUNTRY = new Set(["united states", "usa", "ukraine", "russia", "iran"]);

const COMMODITY_ETF: Record<string, string> = {
  oil: "USO", crude: "USO", "crude oil": "USO", brent: "BNO", gasoline: "UGA",
  "natural gas": "UNG", gas: "UNG", lng: "UNG",
  gold: "GLD", silver: "SLV", copper: "CPER", platinum: "PPLT", palladium: "PALL",
  wheat: "WEAT", corn: "CORN", soybeans: "SOYB", sugar: "CANE", coffee: "JO",
  uranium: "URA", lithium: "LIT", "rare earths": "REMX", steel: "SLX",
  aluminum: "JJU", nickel: "JJN", cocoa: "NIB", bitcoin: "IBIT",
};

// --- SEC company_tickers.json cache (free; ~10k US-listed issuers) ----------
interface SecRow { cik_str: number; ticker: string; title: string }
let _secMap: SecRow[] | null = null;
let _secAt = 0;
let _secFailAt = 0; // negative cache: never re-timeout once per entity in a pass

async function secCompanies(): Promise<SecRow[]> {
  if (_secMap && Date.now() - _secAt < 24 * 3600_000) return _secMap;
  // A stale-but-good list beats N sequential timeouts while the loom advisory
  // lock is held; back off 10 minutes after a failure.
  if (Date.now() - _secFailAt < 600_000) {
    if (_secMap) return _secMap;
    throw new Error("SEC tickers unavailable (backoff)");
  }
  try {
    const res = await fetch("https://www.sec.gov/files/company_tickers.json", {
      headers: { "user-agent": "EREBUS-LOOM research jrelliott093@gmail.com" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`SEC tickers ${res.status}`);
    const j = (await res.json()) as Record<string, SecRow>;
    _secMap = Object.values(j);
    _secAt = Date.now();
    return _secMap;
  } catch (e) {
    _secFailAt = Date.now();
    if (_secMap) return _secMap; // serve stale rather than lose the whole pass
    throw e;
  }
}

const COMPANY_STOPWORDS = /\b(inc|corp|corporation|company|co|ltd|plc|holdings?|group|the|sa|nv|ag|se)\b/g;
// Punctuation is DELETED, not spaced: "McDonald's" -> "mcdonalds", which matches
// SEC's "MCDONALDS CORP" (spacing it produced "mcdonald s" and never resolved).
// Hyphens/slashes DO become spaces: "Coca-Cola" -> "coca cola" = "COCA COLA CO".
function normCompany(s: string): string {
  return s
    .toLowerCase()
    .replace(/['\u2019.,]/g, "")
    .replace(/[-\u2013\u2014/]/g, " ")
    .replace(COMPANY_STOPWORDS, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function pickShareClass(rows: SecRow[]): { ticker: string; cik: string } | null {
  // Prefer the plain common-stock line: no class/structured-product suffix,
  // then the shortest symbol (GOOGL/GOOG -> GOOG).
  const plain = rows.filter((r) => !/[-.]/.test(r.ticker));
  const pool = plain.length ? plain : rows;
  const best = [...pool].sort(
    (a, b) => a.ticker.length - b.ticker.length || a.ticker.localeCompare(b.ticker)
  )[0];
  return best ? { ticker: best.ticker, cik: String(best.cik_str) } : null;
}

// Resolve a company name to {ticker, cik} via the SEC list. CONSERVATIVE by
// design: a wrong ticker silently poisons every downstream event study, flag,
// and forecast, so ambiguity resolves to null (no linkage) rather than a guess.
// Review-confirmed traps this now rejects: multi-CIK exact collisions
// ("Graham" -> GHC vs GHM, "Target" -> TGT vs CBDY) and reverse-prefix
// subsidiary matches when the real parent is not an SEC filer
// ("Siemens" -> Siemens Energy, "Tencent" -> Tencent Music, "X Corp" -> X Financial).
async function resolveCompany(name: string): Promise<{ ticker: string; cik: string } | null> {
  const rows = await secCompanies();
  const n = normCompany(name);
  // Very short names are too collision-prone for prefix matching ("X", "Toro").
  if (!n || n.length < 4) return null;

  const exact = rows.filter((r) => normCompany(r.title) === n);
  if (exact.length) {
    const ciks = new Set(exact.map((r) => r.cik_str));
    if (ciks.size > 1) return null; // different issuers, same normalized name
    return pickShareClass(exact); // one CIK => genuine share classes
  }

  // Prefix match ONLY when the SEC title extends the queried name. The reverse
  // direction is the subsidiary trap and is no longer accepted.
  const prefix = rows.filter((r) => normCompany(r.title).startsWith(n + " "));
  const ciks = new Set(prefix.map((r) => r.cik_str));
  if (ciks.size !== 1) return null;
  return pickShareClass(prefix);
}

async function ensureInstrument(symbol: string, kind: string, name?: string): Promise<string> {
  const [existing] = await db
    .select({ id: loomInstruments.id })
    .from(loomInstruments)
    .where(eq(loomInstruments.symbol, symbol))
    .limit(1);
  if (existing) return existing.id;
  const [row] = await db
    .insert(loomInstruments)
    .values({ symbol, kind, name: name ?? null })
    .onConflictDoNothing()
    .returning({ id: loomInstruments.id });
  if (row) return row.id;
  const [again] = await db
    .select({ id: loomInstruments.id })
    .from(loomInstruments)
    .where(eq(loomInstruments.symbol, symbol))
    .limit(1);
  return again!.id;
}

interface NerEntity { name: string; kind: string; salience: number }

export interface LoomEntityResult {
  narrativesScanned: number;
  entitiesLinked: number;
  tickersResolved: number;
  cost: number;
}

// NER + resolution pass over promoted narratives that have no entity links yet.
export async function resolveNarrativeEntities(): Promise<LoomEntityResult> {
  const r: LoomEntityResult = { narrativesScanned: 0, entitiesLinked: 0, tickersResolved: 0, cost: 0 };

  // entities_scanned_at is the sentinel: each narrative is scanned ONCE, even
  // when extraction legitimately yields nothing linkable (people/institutions
  // are outside the Phase 2 taxonomy). Keying off "has no entity rows" let
  // zero-entity narratives hold the top LIMIT slots and burn a paid call every
  // hour forever.
  const pending = await db.execute(sql`
    SELECT n.id FROM loom_narratives n
     WHERE n.promoted_at IS NOT NULL
       AND n.entities_scanned_at IS NULL
     ORDER BY n.last_seen_at DESC
     LIMIT ${NER_BATCH}
  `);

  for (const row of (pending as unknown as { rows: Array<{ id: string }> }).rows) {
    const samples = await db
      .select({ title: loomArticles.title, lede: loomArticles.lede })
      .from(loomArticles)
      .where(eq(loomArticles.narrativeId, row.id))
      .orderBy(desc(loomArticles.firstSeenAt))
      .limit(6);
    if (!samples.length) continue;

    const res = await callJSON<{ entities: NerEntity[] }>(
      loomEntityPrompt(samples.map((s) => ({ title: s.title || "", lede: s.lede || "" }))),
      { entities: [] },
      { tier: "sonnet", agent: "loom-ner", }
    );
    r.cost += res.cost;
    // Offline costs nothing (paused/over-budget) -> retry freely, no sentinel.
    // A parsed response is a completed scan even if it named nothing: stamp it.
    if (res.offline) continue;
    await db
      .update(loomNarratives)
      .set({ entitiesScannedAt: sql`now()` })
      .where(eq(loomNarratives.id, row.id));
    if (!res.parsed) continue;
    r.narrativesScanned++;

    for (const ent of (res.data.entities || []).slice(0, 6)) {
      const kind = ent.kind === "company" || ent.kind === "country" || ent.kind === "commodity" ? ent.kind : null;
      const name = (ent.name || "").trim().slice(0, 120);
      if (!kind || !name) continue;
      const canon = kind === "company" ? name : name.toLowerCase();
      // Countries and commodities are CLOSED vocabularies here: if the name is
      // not in the proxy map it yields no exposure edge, so it is noise at best
      // and a miscategorization at worst (a live run filed "Mark Carney" — a
      // person — as a country). Companies stay open: an unresolved company is
      // still a real entity that may resolve later.
      if (kind === "country" && !COUNTRY_ETF[canon]) continue;
      if (kind === "commodity" && !COMMODITY_ETF[canon]) continue;

      // find-or-create the entity
      let [entity] = await db
        .select({ id: loomEntities.id, ticker: loomEntities.ticker })
        .from(loomEntities)
        .where(and(eq(loomEntities.kind, kind), sql`lower(${loomEntities.canonName}) = lower(${canon})`))
        .limit(1);
      if (!entity) {
        const [created] = await db
          .insert(loomEntities)
          .values({ kind, canonName: canon })
          .onConflictDoNothing()
          .returning({ id: loomEntities.id, ticker: loomEntities.ticker });
        entity = created ?? (await db
          .select({ id: loomEntities.id, ticker: loomEntities.ticker })
          .from(loomEntities)
          .where(and(eq(loomEntities.kind, kind), sql`lower(${loomEntities.canonName}) = lower(${canon})`))
          .limit(1))[0];
      }
      if (!entity) continue;

      // resolve to an instrument + exposure edge (idempotent)
      if (kind === "company" && !entity.ticker) {
        try {
          const hit = await resolveCompany(name);
          if (hit) {
            await db.update(loomEntities).set({ ticker: hit.ticker, cik: hit.cik }).where(eq(loomEntities.id, entity.id));
            const instId = await ensureInstrument(hit.ticker, "equity", name);
            await db
              .insert(loomExposures)
              .values({ entityId: entity.id, instrumentId: instId, weight: 1.0, kind: "direct" })
              .onConflictDoNothing();
            r.tickersResolved++;
          }
        } catch {
          /* SEC fetch down — entity stays unresolved, retried when seen again */
        }
      } else if (kind === "country") {
        const symbol = COUNTRY_ETF[canon];
        if (symbol) {
          const weak = WEAK_COUNTRY.has(canon);
          const instId = await ensureInstrument(symbol, "etf", `${canon} proxy`);
          await db
            .insert(loomExposures)
            .values({ entityId: entity.id, instrumentId: instId, weight: weak ? 0.3 : 1.0, kind: "country_proxy" })
            .onConflictDoNothing();
        }
      } else if (kind === "commodity") {
        const symbol = COMMODITY_ETF[canon];
        if (symbol) {
          const instId = await ensureInstrument(symbol, "etf", `${canon} proxy`);
          await db
            .insert(loomExposures)
            .values({ entityId: entity.id, instrumentId: instId, weight: 1.0, kind: "commodity_proxy" })
            .onConflictDoNothing();
        }
      }

      const salience = Math.max(0, Math.min(1, Number(ent.salience) || 0.5));
      const [link] = await db
        .insert(loomNarrativeEntities)
        .values({ narrativeId: row.id, entityId: entity.id, salience })
        .onConflictDoNothing()
        .returning({ id: loomNarrativeEntities.id });
      if (link) r.entitiesLinked++;
    }
  }

  return r;
}

// Ranked exposed instruments for one narrative (drives event studies + M5).
export async function narrativeInstruments(
  narrativeId: string
): Promise<Array<{ instrumentId: string; symbol: string; weight: number; entity: string }>> {
  const res = await db.execute(sql`
    SELECT i.id AS instrument_id, i.symbol,
           max(ne.salience * x.weight) AS weight,
           (array_agg(e.canon_name ORDER BY (ne.salience * x.weight) DESC))[1] AS entity
      FROM loom_narrative_entities ne
      JOIN loom_entities e ON e.id = ne.entity_id
      JOIN loom_exposures x ON x.entity_id = e.id
      JOIN loom_instruments i ON i.id = x.instrument_id
     WHERE ne.narrative_id = ${narrativeId}::uuid
     GROUP BY i.id, i.symbol
     ORDER BY max(ne.salience * x.weight) DESC
     LIMIT 8
  `);
  return (res as unknown as { rows: Array<Record<string, unknown>> }).rows.map((r) => ({
    instrumentId: r.instrument_id as string,
    symbol: r.symbol as string,
    weight: Number(r.weight) || 0,
    entity: r.entity as string,
  }));
}

export { ensureInstrument };
