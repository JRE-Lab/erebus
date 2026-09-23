# EREBUS — improvement plan (UI rebuild + engine fixes)

_Written 2026-09-19 from live production data. Pick this up cold: every claim
below is a measurement, and the query that produced it is inline so you can
re-run it before acting. Work packages are ordered by value ÷ effort._

---

## The headline: the system is now measuring itself, and the measurements are damning in three specific places

EREBUS has 316 externally resolved forecasts and a mean Brier of **0.171**
against a climatological 0.249 — it is a genuinely calibrated forecaster, 31%
better than guessing the base rate. That is the real achievement of the build
so far and it is currently rendered as 12px grey text in a stat row.

But disaggregate it and three things fall out:

### 1. The autonomous theory factory is worse than guessing

```sql
SELECT origin, count(*) resolved, round(avg(brier)::numeric,3) brier,
       round(avg(CASE WHEN resolved_outcome THEN 1 ELSE 0 END)::numeric,3) base_rate
  FROM nodes WHERE brier IS NOT NULL GROUP BY origin;
```

| origin | resolved | Brier | base rate | climatology p(1−p) | verdict |
|---|---|---|---|---|---|
| `user` (your seeds) | 225 | **0.145** | 0.569 | 0.245 | **41% better than climatology** ✅ |
| `shadow` (dark theories) | 73 | 0.230 | 0.233 | 0.179 | **worse than climatology** ❌ |
| `erebus` (genesis) | 18 | 0.250 | 0.111 | 0.099 | **worse than climatology** ❌ |

Your hand-seeded theories are the calibrated ones. The autonomously generated
theories — the part you named as the top priority — are currently *worse than
a constant guess*, and dark theories come true only 23% of the time.

We built R6 (kill criteria for a losing forecast head) for LOOM. **EREBUS core
has no equivalent**, so nothing flags this. It has been true for weeks.

### 2. Both LOOM forecast heads are already flagged advisory — because the hand-set priors are simply wrong

`GET /api/loom/scoreboard`:

| head | n | Brier | climatology | base rate | prior we issue at |
|---|---|---|---|---|---|
| `lifecycle` | 197 | 0.294 | 0.075 | **0.919** | 0.45 |
| `market_move` | 83 | 0.288 | 0.124 | **0.145** | 0.55 |

R6 is working exactly as designed: it caught both heads and pulled them to
advisory. The cause is not subtle — we forecast 0.45 on something that happens
92% of the time, and 0.55 on something that happens 14.5% of the time. Brier
0.294 ≈ (0.45−1)², i.e. *the entire error is the prior*.

The analog machinery (M7) was supposed to fix this but it gates on 5
regime-matched precedents *per narrative*, which rarely fires. There is a much
simpler correction available: 197 and 83 resolutions are more than enough to
use the **observed base rate** as the prior.

Two further questions this raises, which the fix should answer, not paper over:
- **Is the lifecycle claim worth making at all?** A 92% base rate means
  "amplifying → peak within 72h" is nearly automatic given the hysteresis in
  the lifecycle machine. A claim that is almost always true carries little
  information even when perfectly calibrated.
- **Is the market direction rule anti-predictive?** A 1–3% move in a *stated*
  direction over 7 days should land near 35–40% unconditionally. We hit 14.5%.
  That is materially *worse than random*, which suggests the direction signal
  (sign of the observed CAR) is inverted or noise. Test before trusting.

### 3. Genesis mints roots faster than expansion can explore them

```
480 roots · 417 of them with ZERO children (87%) · none expand_blocked
162 new roots in the last 7 days · 181 nodes expanded in the same window
```

Depth distribution is bimodal: ~63 roots carry deep subtrees (250→338 nodes per
level down to depth 8, where MAX_DEPTH bites), and 417 roots are orphan stumps
that were created and never touched again. The blueprint's thesis is *build
from the green* — branch outward from corroborated nodes — and instead the
tree is growing a field of stumps.

This is also **why the Explorer looks empty**: the SVG lays nodes out by depth
(x) and packs leaves vertically (y), so 417 childless roots stack into a single
sparse column at x=0 while the real structure sits off-screen.

### Supporting numbers

| metric | value | note |
|---|---|---|
| unseen alerts | **2,203** | 988 greened, 429 contradicted, 468 genesis, 313 resolved |
| signals / matches last 7d | 6,911 / 25,994 | ~3.8 LLM judgements per signal |
| spend last 7d | $5.74 | ~$0.82/day, well inside the cap |
| LOOM | 283 promoted narratives, 280 resolved forecasts, 248 bridge signals | healthy |
| `autonomous` | **false** | switched off at some point after 2026-08-25 |

---

## Work packages

Ordered by value ÷ effort. WP1–WP3 are small and high-value; do them first
regardless of the UI work.

### WP1 — Close the calibration loop (empirical priors) · ✅ SHIPPED 2026-09-23

The scoreboard measures the error; nothing feeds it back. Make issuance read
its own history.

- In `packages/loom/src/forecasts.ts`, add a `basePrior(claimType)` that reads
  the head's resolved base rate and returns it once `n ≥ 30`, shrunk toward the
  hand-set value (e.g. `(hits + k·prior) / (n + k)`, k≈10) so it moves smoothly.
- Priority order for a claim's probability: **analog prior (informative) →
  empirical head base rate (n≥30) → hand-set constant**. Record which tier was
  used in `target_ref.priorBasis`; the card already renders it.
- Apply the same idea to the tree: a new forecast's starting probability is
  currently always 0.5. Seed it from the resolved base rate of its origin +
  domain segment instead.

**Shipped.** `packages/loom/src/priors.ts` — tiered prior (informative analog →
head's own base rate at n≥30, shrunk by a pseudo-count → hand-set constant).
Verified live in the worker:

```
lifecycle : prob 0.896  tier empirical  "246-resolution base rate 91% (shrunk to 90%)"
market    : prob 0.289  tier empirical  "123-resolution base rate 27% (shrunk to 29%)"
```

New claims now issue at those instead of the flat 0.45 / 0.55. Expected Brier
once they resolve: **0.294 → ~0.078** (lifecycle) and **0.276 → ~0.197**
(market). The scoreboard improves as new resolutions replace old ones in the
90-day window, not instantly — lifecycle claims have 72h windows so it should
move within days.

The scoreboard also gained an honesty upgrade it needed *because* of this
change: issuing a base rate drives Brier **to** climatology and no further, so
the old two-state `live`/`advisory` test would have read "live" and implied
skill that does not exist. It now reports a Brier skill score and four states —
`skillful` (beats climatology beyond one standard error), `calibrated` (matches
it: not wrong, but carrying no case-specific information), `advisory` (worse),
`calibrating` (n < 10). **Only `skillful` can ever satisfy R8.** Both heads read
advisory today with skill scores of −2.76 and −0.40.

### WP2 — REVISED after measurement: the tree's problem is evidence accumulation, not priors · M

> **This work package was rewritten on 2026-09-23.** The plan assumed dark
> theories were miscalibrated because their prior starts at 0.5. The data says
> otherwise, and the real cause is more interesting.

**What was measured.** Reliability curves by origin, over all 317 resolved nodes:

| we said | user seeds: happened | dark theories: happened |
|---|---|---|
| ≥ 0.80 | 0.895 (n=86) | 0.571 (n=7) |
| 0.60–0.79 | 0.712 (n=52) | 0.455 (n=11) |
| 0.40–0.59 | 0.289 (n=45) | 0.175 (n=40) |
| < 0.40 | 0.023 (n=43) | 0.067 (n=15) |

User seeds trace a near-diagonal reliability curve — that is a genuinely good
forecaster. Dark theories are **monotonic but over-confident at every level**:
the *ordering* carries information, the *magnitudes* are inflated.

The structural difference is evidence volume:

| origin | avg non-neutral matches per resolved node | Brier |
|---|---|---|
| user | 8.2 | 0.149 |
| erebus | 8.8 | 0.250 |
| shadow (dark) | **95.2** | 0.230 |

And calibration gets **worse** past ~20 matches:

| matches | n | we said | happened | Brier |
|---|---|---|---|---|
| 0 | 23 | 0.500 | 0.261 | 0.250 |
| 1–5 | 182 | 0.593 | 0.445 | 0.168 |
| 6–20 | 97 | 0.708 | 0.567 | **0.141** |
| 21–60 | 8 | 0.733 | 0.500 | 0.228 |
| 60+ | 7 | 0.495 | 0.143 | **0.445** |

Evidence helps up to ~20 matches and then actively hurts. (The last two buckets
are thin, n=8 and n=7 — treat the size of the effect as provisional, but the
direction agrees with the per-origin table, where the 95-match segment is the
miscalibrated one.)

The mix is the clincher. Dark theories receive **four times more refuting than
confirming matches** (5,581 refutes vs 1,365 confirms) and still finish at an
average probability of 0.511 against a 23% base rate. The evidence says *no*
far more often than *yes*, and the final probability does not reflect it.

**Mechanism.** `applyMatch` (`packages/core/src/greening.ts`) clamps the
probability to `[P_FLOOR, P_CEIL]` = `[0.02, 0.98]` on **every** update, so the
accumulated log-odds can never leave ±3.89 nats. At `weight · LLR_SCALE` ≈
0.2–0.4 nats per match, anything past roughly 10–20 matches saturates: the
final probability is dominated by the most recent handful of matches rather
than by the whole evidence history. The update is **order-dependent instead of
accumulative**. User seeds (8.2 matches) sit inside the range where this
behaves; dark theories (95.2) are far outside it.

**Work:**

- **2a. Fix accumulation.** Keep a running unbounded (or widely bounded)
  log-odds on the node and derive probability from it, clamping only for
  display and state. Then 76 refutes actually hold a theory down.
- **2b. Discount correlated evidence.** 95 matches on one node are not 95
  independent observations — they are one story re-reported. This is the same
  insight that gave the LOOM→tree bridge its 0.5 weight scale. Options: decay
  the Nth match's weight within a time window, or dedupe by narrative cluster
  (the bridge already gives us narrative identity for an article).
- **2c. Backtest before shipping.** Both fixes are pure functions of the
  existing `signal_matches` history, so **replay them over all 317 resolved
  nodes and compare Brier** against today's 0.171 before any deploy. This is
  the rare case where the change can be validated offline; do not skip it.
- **2d. Then** add the per-segment scoreboard (`calibrationBySegment()` in
  `packages/core/src/scoring.ts`, `GET /api/calibration/segments`, advisory
  status per origin/domain) to verify the fix held and to surface segments in
  the UI.
- **2e. Only then** revisit the dark-genesis prompt. The open question is
  whether the judge is confirming a *theme* while the resolver checks an
  *event* — two different questions. Fixing accumulation may absorb most of the
  error; re-measure before rewriting prompts.

**Do NOT** seed new nodes at their segment base rate (the original WP1 idea).
`THRESH.contradicted` is −0.5, i.e. p ≤ 0.25, so seeding dark theories at their
0.233 base rate would mark them *contradicted at birth*. Absolute probability
and evidence-movement are conflated in the state machine; that coupling would
have to be separated first, and after 2a/2b it may not be worth doing.

### WP3 — Rebalance genesis vs expansion · S

- Gate the genesis tick on a backlog rule: skip minting new roots while
  `unexpanded_roots > LOOM-style threshold` (e.g. 50).
- Bias `selectNext` toward **childless roots that have greened** — a root with
  signal support and no children is the highest-value expansion target and is
  exactly what is being starved today.
- Let the gardener prune stumps: roots older than N days with zero children and
  zero signal matches are dead wood; the machinery already exists.
- Re-enable `autonomous` (it is currently off) once the above is in, so the
  rebalanced loop actually runs.

**Acceptance:** childless-root share falls below ~40% within a week of running,
and depth-1 node count grows faster than root count.

### WP4 — Alert on surprise, not on events · S

2,203 unseen alerts is the same as none. Every state transition currently fires.

- Replace event-kind triggers with **surprise** triggers:
  - |Δ log-odds| on a single update above a threshold (a big Bayesian jump),
  - a **launch point** getting contradicted (expensive to be wrong about),
  - a **dark theory greening** (rare given a 23% base rate → informative),
  - a calibration segment flipping to advisory,
  - a LOOM head flipping advisory, or a narrative crossing into `peak` with a
    pre-positioning flag attached.
- Keep the rest as a digest, not a bell.
- One-off: mark the 2,203 existing alerts seen.

**Acceptance:** under ~10 alerts/week, each one a thing you would actually open.

### WP5 — UI rebuild (the main ask) · L

**Diagnosis.** The dashboard shows *inventory*, not *attention*. Four
simultaneous scrolling lists (480 theory cards, a 2,729-node canvas, a node
panel, a signal feed), a stat wall of totals, 99+ alerts. Nothing answers "what
should I look at right now?" Meanwhile the one number that proves the system
works (Brier 0.171 vs 0.249) is grey 12px text.

Current layout: `apps/web/app/page.tsx` (653 lines) renders
`230px theories | flex tree | 420px detail | 300px signals` — on a 1920px screen
the tree gets ~900px, and the 420px detail column sits empty saying "Select a
node" until you click something.

**Principle for the rebuild:** *the front page answers "what changed and what
deserves me", not "how much exists".*

#### 5a. New default view — **Briefing**
Replaces the stat wall as the landing page. A single ranked column, ~10 items,
each one sentence + a link:
- movements since last visit (greened / contradicted / tipping), ranked by
  surprise from WP4;
- calibration status per segment, with advisory segments called out;
- LOOM narratives that crossed into amplifying/peak with market exposure;
- anything needing a decision (due-unresolved forecasts, disputed resolutions).
Top strip: Brier vs climatology, spend today, autonomous/continuous state,
last tick times. Everything else is one click away.

#### 5b. Explorer — stop rendering the whole forest
The tree view must never lay out 2,729 nodes. Two modes:
- **Forest** (default): roots as cards in a responsive grid, grouped/filterable
  by state, origin, domain, has-children, greened. This is what the 230px
  theory list is failing to be — give it the full width and make it searchable
  and sortable (by probability, recency, children, signal support).
- **Tree**: one root's subtree at a time, entered by clicking a card. At ≤338
  nodes per subtree the existing SVG layout works fine.
Keep the detail panel but make it a right drawer that opens on selection
instead of a permanently reserved 420px column.

#### 5c. Calibration page
Make the scoreboard first-class: overall Brier vs climatology, per-origin and
per-domain tables from WP2, the LOOM head table with R6 status, a reliability
diagram (predicted vs observed in deciles), and the resolution log. This is the
system's conscience; it deserves a page, not a stat.

#### 5d. Readability pass
- Base font up (11–12px body is too small at 1080p); `--nx-text-muted` (#6b6b85
  on #0a0a0f) is below comfortable contrast for body text — reserve it for
  genuine de-emphasis.
- Monospace node IDs are prime real estate spent on the least useful field —
  demote to a hover/tooltip.
- One accent per state, used consistently; the current chip/badge/dot/border
  encodings overlap.
- Collapse the signal feed into a drawer; it is ambient, not primary.
- Give the action row a clear split between **toggles** (autonomous,
  continuous) and **one-shot actions** (roam once, genesis, verify) — they are
  visually identical today, and "Descending..." reads as a status, not a control.

**Suggested order:** 5d (cheap, immediate relief) → 5a → 5b → 5c.

**Acceptance:** you can answer "what changed and what needs me?" in under 10
seconds on the landing page, and navigate to any of 480 theories in two clicks
without scrolling a flat list.

### WP6 — Cut the matching bill · M · optional

25,994 LLM judgements over 6,911 signals in 7 days, most returning neutral. The
embedding distance is already computed before the judge runs — add a cosine
floor (tune on the existing match corpus: find the distance above which
confirm/refute essentially never occurs) and skip the call below it. Likely a
large reduction in judge calls at no measurable accuracy cost. Verify against
held-out matches before shipping.

---

## Notes for the next session

- **Do WP1 first.** It is arithmetic over data we already have, it fixes the
  two worst-calibrated things in the system, and its effect is immediately
  visible in the scoreboard.
- Re-run the queries at the top before acting — several weeks may have passed
  and the numbers move.
- `autonomous` is currently **off**; several findings (stump accumulation)
  partly stem from an on/off history, so check
  `SELECT value FROM settings WHERE key='autonomous'` before drawing conclusions
  about the loop's behaviour.
- The Anthropic key is still 401 → the deep tier is running on the gpt-4o
  fallback. Genesis and dark-genesis quality (finding 1) is being judged on
  fallback-model output; a new key may itself move those numbers. Install the
  key before rewriting the dark-genesis prompt, or you will be tuning against
  the wrong model.
- Every phase of this project shipped after an adversarial multi-agent review of
  the diff. Keep that for WP1–WP3 (they touch probability math and the
  autonomous loop); WP5 is UI and does not need it.
