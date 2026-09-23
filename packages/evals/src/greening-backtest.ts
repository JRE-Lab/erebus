// ============================================================================
// Greening backtest — replay every resolved node's evidence under candidate
// update rules and score the result against what actually happened.
//
// WHY. WP2 measured that calibration DEGRADES with evidence volume: Brier
// 0.141 in the 6-20 match band, 0.445 past 60. The suspected cause is that
// `applyMatch` clamps probability to [P_FLOOR, P_CEIL] on EVERY update, so the
// running log-odds can never leave +/-3.89 nats and a long evidence history is
// dominated by its most recent few matches (order-dependent, not
// accumulative). A second suspect is that the matches are not independent:
// 95 matches on one dark theory are largely one story re-reported.
//
// Both suspects are pure functions of stored `signal_matches`, so they can be
// tested offline against ground truth BEFORE any production change. That is
// what this file is for. Nothing here writes to the database.
//
// HONESTY. Candidate rules have free parameters, and there are only ~318
// resolved nodes. Tuning on all of them would fit noise, so every parameterised
// rule is tuned on a TRAIN split and reported on a held-out TEST split. The
// test column is the only one that counts.
//
// Run:  docker exec erebus-worker sh -lc 'cd /app && npx tsx packages/evals/src/greening-backtest.ts'
// ============================================================================
import { sql } from "drizzle-orm";
import { db } from "@erebus/db";

const P_FLOOR = 0.02;
const P_CEIL = 0.98;
const LLR_SCALE = 0.5;
const START_P = 0.5; // nodes.probability default

const clampP = (p: number) => Math.max(P_FLOOR, Math.min(P_CEIL, p));
const toLogOdds = (p: number) => Math.log(clampP(p) / (1 - clampP(p)));
const fromLogOdds = (lo: number) => clampP(1 / (1 + Math.exp(-lo)));

interface Match {
  dir: 1 | -1;
  weight: number;
}
interface Case {
  id: string;
  origin: string;
  outcome: 0 | 1;
  storedP: number;
  matches: Match[];
}

type Rule = { name: string; run: (m: Match[]) => number };

// --- the rules ---------------------------------------------------------------

// R0: exactly what production does today. Its job is to VALIDATE the replay —
// if this does not reproduce the stored probability, the harness is wrong and
// every other number here is meaningless.
const ruleCurrent: Rule = {
  name: "R0 current (clamp every step)",
  run: (ms) => {
    let p = START_P;
    for (const m of ms) p = fromLogOdds(toLogOdds(p) + m.dir * m.weight * LLR_SCALE);
    return p;
  },
};

// R1: accumulate log-odds without the per-step clamp; clamp once at the end.
// Evidence then actually adds up, and order stops mattering.
const ruleAccumulate: Rule = {
  name: "R1 unbounded accumulation",
  run: (ms) => {
    let lo = toLogOdds(START_P);
    for (const m of ms) lo += m.dir * m.weight * LLR_SCALE;
    return fromLogOdds(lo);
  },
};

// R2: accumulation + correlated-evidence discount. The n-th match on a node is
// worth tau/(tau+n) of its nominal weight, so a burst of coverage about one
// story cannot masquerade as n independent observations. This is the same
// insight that gave the LOOM->tree bridge its 0.5 weight scale.
const ruleDiscount = (tau: number): Rule => ({
  name: `R2 accumulation + correlated discount (tau=${tau})`,
  run: (ms) => {
    let lo = toLogOdds(START_P);
    ms.forEach((m, i) => {
      lo += m.dir * m.weight * LLR_SCALE * (tau / (tau + i));
    });
    return fromLogOdds(lo);
  },
});

// R3: accumulation with a cap on total evidence — an explicit ceiling on how
// far any amount of evidence may move a forecast from its prior.
const ruleCap = (cap: number): Rule => ({
  name: `R3 accumulation capped at +/-${cap} nats`,
  run: (ms) => {
    let lo = toLogOdds(START_P);
    for (const m of ms) lo += m.dir * m.weight * LLR_SCALE;
    const base = toLogOdds(START_P);
    return fromLogOdds(base + Math.max(-cap, Math.min(cap, lo - base)));
  },
});

// R4: RECALIBRATION. The reliability curves say dark theories are monotonic
// but over-confident at every level: the ranking carries real information and
// only the magnitudes are inflated. That is a mapping problem, not a
// derivation problem, so fit a Platt map p_cal = sigmoid(a*logit(p_raw) + b)
// on resolved history and apply it to the raw score. Fit on TRAIN only.
interface Platt { a: number; b: number; n: number }

function fitPlatt(xs: number[], ys: number[], prior = 1): Platt {
  // logistic regression on one feature, with mild shrinkage toward the
  // identity map (a=1,b=0) so a thin segment cannot learn a wild correction.
  let a = 1, b = 0;
  const n = xs.length;
  if (n < 12) return { a: 1, b: 0, n };
  const lambda = prior / n;
  for (let it = 0; it < 4000; it++) {
    let ga = 0, gb = 0;
    for (let i = 0; i < n; i++) {
      const pz = 1 / (1 + Math.exp(-(a * xs[i]! + b)));
      const e = pz - ys[i]!;
      ga += e * xs[i]!;
      gb += e;
    }
    ga = ga / n + lambda * (a - 1);
    gb = gb / n + lambda * b;
    a -= 0.5 * ga;
    b -= 0.5 * gb;
  }
  return { a, b, n };
}

const applyPlatt = (p: number, m: Platt) =>
  clampP(1 / (1 + Math.exp(-(m.a * toLogOdds(p) + m.b))));

// --- scoring -----------------------------------------------------------------

const brier = (cases: Case[], rule: Rule) =>
  cases.reduce((a, c) => a + (rule.run(c.matches) - c.outcome) ** 2, 0) / (cases.length || 1);

function byOrigin(cases: Case[], rule: Rule) {
  const out = new Map<string, { n: number; b: number }>();
  for (const c of cases) {
    const e = out.get(c.origin) ?? { n: 0, b: 0 };
    e.n++;
    e.b += (rule.run(c.matches) - c.outcome) ** 2;
    out.set(c.origin, e);
  }
  return [...out.entries()]
    .map(([o, e]) => `${o} ${(e.b / e.n).toFixed(3)} (n=${e.n})`)
    .sort()
    .join("  ");
}

async function load(): Promise<Case[]> {
  const res = await db.execute(sql`
    SELECT n.id, n.origin, n.probability AS stored_p,
           (CASE WHEN n.resolved_outcome THEN 1 ELSE 0 END) AS outcome,
           COALESCE(json_agg(
             json_build_object('effect', sm.effect, 'weight', sm.weight)
             ORDER BY sm.created_at
           ) FILTER (WHERE sm.id IS NOT NULL AND sm.effect <> 'neutral'), '[]') AS matches
      FROM nodes n
      LEFT JOIN signal_matches sm ON sm.node_id = n.id
     WHERE n.brier IS NOT NULL AND n.resolved_outcome IS NOT NULL
     GROUP BY n.id, n.origin, n.probability, n.resolved_outcome
  `);
  return (res as unknown as { rows: Array<Record<string, unknown>> }).rows.map((r) => ({
    id: r.id as string,
    origin: (r.origin as string) ?? "user",
    outcome: Number(r.outcome) as 0 | 1,
    storedP: Number(r.stored_p),
    matches: (r.matches as Array<{ effect: string; weight: number }>).map((m) => ({
      dir: m.effect === "confirm" ? 1 : (-1 as 1 | -1),
      weight: Math.max(0, Math.min(1, Number(m.weight))),
    })),
  }));
}

// Deterministic split so reruns are comparable.
function split(cases: Case[]) {
  const hash = (s: string) => {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return Math.abs(h);
  };
  const train = cases.filter((c) => hash(c.id) % 10 < 6);
  const test = cases.filter((c) => hash(c.id) % 10 >= 6);
  return { train, test };
}

async function main() {
  const cases = await load();
  const { train, test } = split(cases);
  const withEvidence = cases.filter((c) => c.matches.length > 0);

  console.log(`\n=== Greening backtest — ${cases.length} resolved nodes ` +
    `(${withEvidence.length} with evidence), train ${train.length} / test ${test.length}\n`);

  // Fidelity check first: does R0 reproduce production?
  const drift = withEvidence.map((c) => Math.abs(ruleCurrent.run(c.matches) - c.storedP));
  const meanDrift = drift.reduce((a, b) => a + b, 0) / (drift.length || 1);
  const maxDrift = Math.max(...drift, 0);
  console.log(`REPLAY FIDELITY  mean |replayed - stored| = ${meanDrift.toFixed(4)}  max = ${maxDrift.toFixed(4)}`);
  console.log(meanDrift < 0.02
    ? "  -> faithful; the comparisons below are meaningful.\n"
    : "  -> NOT faithful. Something else moves probability (ACH? market?). Fix before trusting anything below.\n");

  const candidates: Rule[] = [
    ruleCurrent,
    ruleAccumulate,
    ...[2, 4, 6, 8, 12, 20, 30].map(ruleDiscount),
    ...[1, 2, 3, 4].map(ruleCap),
  ];

  console.log("rule".padEnd(48) + "train".padEnd(9) + "test".padEnd(9) + "all");
  console.log("-".repeat(80));
  const scored = candidates.map((r) => ({
    rule: r,
    train: brier(train, r),
    test: brier(test, r),
    all: brier(cases, r),
  }));
  for (const s of scored) {
    console.log(
      s.rule.name.padEnd(48) +
        s.train.toFixed(4).padEnd(9) +
        s.test.toFixed(4).padEnd(9) +
        s.all.toFixed(4)
    );
  }

  // Pick on TRAIN only, then report its held-out result — never pick on test.
  const baseline = scored[0]!;
  const best = scored.slice(1).reduce((a, b) => (b.train < a.train ? b : a));
  console.log(`\nbaseline : ${baseline.rule.name}`);
  console.log(`           test Brier ${baseline.test.toFixed(4)}   ${byOrigin(test, baseline.rule)}`);
  console.log(`best on train: ${best.rule.name}`);
  console.log(`           test Brier ${best.test.toFixed(4)}   ${byOrigin(test, best.rule)}`);
  const delta = baseline.test - best.test;
  console.log(
    `\nheld-out improvement: ${delta >= 0 ? "-" : "+"}${Math.abs(delta).toFixed(4)} Brier ` +
      `(${((delta / baseline.test) * 100).toFixed(1)}% ${delta >= 0 ? "better" : "WORSE"})`
  );
  if (delta <= 0) console.log("NOTE: no held-out gain. Do not ship a change on this evidence.");

  // --- R4: recalibration, fit on train, scored on held-out test ------------
  console.log("");
  console.log("=== R4 recalibration (Platt map on the CURRENT score, fit on train only)");
  const rawOf = (c: Case) => ruleCurrent.run(c.matches);
  const globalMap = fitPlatt(train.map((c) => toLogOdds(rawOf(c))), train.map((c) => c.outcome));
  const origins = [...new Set(cases.map((c) => c.origin))];
  const segMaps = new Map<string, Platt>();
  for (const o of origins) {
    const tr = train.filter((c) => c.origin === o);
    segMaps.set(o, fitPlatt(tr.map((c) => toLogOdds(rawOf(c))), tr.map((c) => c.outcome)));
  }
  console.log(`  global map: a=${globalMap.a.toFixed(3)} b=${globalMap.b.toFixed(3)} (n=${globalMap.n})`);
  for (const o of origins) {
    const m = segMaps.get(o)!;
    console.log(`  ${o.padEnd(8)} map: a=${m.a.toFixed(3)} b=${m.b.toFixed(3)} (n=${m.n})` +
      (m.n < 12 ? "  [too thin -> identity]" : ""));
  }

  const brierMapped = (cs: Case[], fn: (c: Case) => number) =>
    cs.reduce((a, c) => a + (fn(c) - c.outcome) ** 2, 0) / (cs.length || 1);

  const rawTest = brierMapped(test, rawOf);
  const globTest = brierMapped(test, (c) => applyPlatt(rawOf(c), globalMap));
  const segTest = brierMapped(test, (c) => applyPlatt(rawOf(c), segMaps.get(c.origin) ?? globalMap));
  console.log("");
  console.log(`  test Brier  raw ${rawTest.toFixed(4)}  |  global map ${globTest.toFixed(4)}  |  per-origin map ${segTest.toFixed(4)}`);

  for (const o of origins) {
    const sub = test.filter((c) => c.origin === o);
    if (!sub.length) continue;
    const base = sub.reduce((a, c) => a + (c.outcome ? 1 : 0), 0) / sub.length;
    console.log(
      `  ${o.padEnd(8)} n=${String(sub.length).padEnd(4)} raw ${brierMapped(sub, rawOf).toFixed(3)}` +
        ` -> per-origin ${brierMapped(sub, (c) => applyPlatt(rawOf(c), segMaps.get(c.origin) ?? globalMap)).toFixed(3)}` +
        `   (its climatology ${(base * (1 - base)).toFixed(3)})`
    );
  }

  // Is the recalibration gain real, or 126 lucky test points? Paired
  // bootstrap over per-case squared errors: if the 90% interval for the
  // improvement excludes zero, the gain survives resampling.
  const perCase = test.map((c) => {
    const raw = (rawOf(c) - c.outcome) ** 2;
    const cal = (applyPlatt(rawOf(c), segMaps.get(c.origin) ?? globalMap) - c.outcome) ** 2;
    return raw - cal; // positive = calibration helped this case
  });
  const boots: number[] = [];
  let seed = 42;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let b = 0; b < 4000; b++) {
    let acc = 0;
    for (let i = 0; i < perCase.length; i++) acc += perCase[Math.floor(rnd() * perCase.length)]!;
    boots.push(acc / perCase.length);
  }
  boots.sort((x, y) => x - y);
  const lo = boots[Math.floor(0.05 * boots.length)]!;
  const hi = boots[Math.floor(0.95 * boots.length)]!;
  const mean = perCase.reduce((a, b2) => a + b2, 0) / perCase.length;
  console.log("");
  console.log(`  paired bootstrap on held-out test: mean Brier improvement ${mean.toFixed(4)}` +
    ` (90% CI ${lo.toFixed(4)} .. ${hi.toFixed(4)}) over n=${perCase.length}`);
  console.log(lo > 0
    ? "  -> interval excludes zero: the recalibration gain survives resampling."
    : "  -> interval includes zero: NOT distinguishable from noise. Do not ship.");

  // Where the change actually bites: by evidence volume.
  console.log("\nby evidence volume (test split, baseline -> best):");
  const bands: Array<[string, (n: number) => boolean]> = [
    ["0", (n) => n === 0],
    ["1-5", (n) => n >= 1 && n <= 5],
    ["6-20", (n) => n >= 6 && n <= 20],
    ["21-60", (n) => n >= 21 && n <= 60],
    ["60+", (n) => n > 60],
  ];
  for (const [label, pred] of bands) {
    const sub = test.filter((c) => pred(c.matches.length));
    if (!sub.length) continue;
    console.log(
      `  ${label.padEnd(7)} n=${String(sub.length).padEnd(4)} ` +
        `${brier(sub, baseline.rule).toFixed(3)} -> ${brier(sub, best.rule).toFixed(3)}`
    );
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
