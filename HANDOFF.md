# EREBUS — Project Handoff

_Last updated 2026-09-07 · branch `forecast-engine` · head `4c9cf64` · migrations through `0012`_

EREBUS is a **forward-branching forecast tree that greens as reality confirms it**.
Each node is a forecast (question + not-yet-happened outcome + indicators +
falsifiers + horizon). Incoming news and market signals are matched to indicators
and move a Bayesian probability; corroborated nodes become launch points to
branch further. On top of the tree sit a **game-theory decision layer**, a
**deception (Shadow Board) layer**, a **theory factory** (genesis / dark genesis),
and **LOOM** — a narrative-intelligence layer that watches how stories move,
attributes intent as competing hypotheses, and feeds the tree back.

---

## 0. Status at a glance

| Area | State |
|---|---|
| EREBUS core (blueprint Phases 0–11) | **Built and live** |
| Hardening pass (80-agent review, 70 findings) | **Done** — `4b192fe` |
| LOOM Phases 0–5 (spec v0.1) | **Built and live** except vendor-gated items |
| LOOM → tree bridge | **Live** — promoted narratives green theories |
| Autonomous toggle | **ON** (re-enabled 2026-08-25 after being off since Jul 2) |
| Anthropic key | ⚠️ **401 — rotated and not replaced.** Deep tier runs on the gpt-4o fallback. Fable 5 is NOT serving. |
| Daily spend | ≈ $0.40–1.00/day on the fallback; hard cap `DAILY_BUDGET_USD` (15) |

Live corpus at last check: **3,845 articles · 28 feeds / 20 outlets · 47 promoted
narratives · 165 R2-complete judgments · 69 pre-registered forecasts · 9 playbooks / 11 matches.**

**Needs a human:** (1) a new Anthropic key via the hand-off flow (§6); (2) vendor
decisions — options-flow (~$75–150/mo) and a GCP project for GDELT; (3) nothing
else — everything below runs unattended within budget.

---

## 1. Where it lives

- **Code:** `C:\Users\jrell\OneDrive\Desktop\JRE-Lab\erebus` — git branch `forecast-engine`, remote `github.com/JRE-Lab/erebus` (gh authed as `JRE-Lab`).
- **Production:** VPS `root@159.203.86.148`, dir `/opt/erebus`, `docker compose -f docker-compose.prod.yml`. Containers: `erebus-web`, `erebus-worker`, `erebus-postgres` (pgvector/pg16), `erebus-redis`.
- **Dashboard:** http://159.203.86.148:4000 — Basic-auth `erebus` / `imitate` (`EREBUS_USER`/`EREBUS_PASS` in `/opt/erebus/.env`).
- **Ports** (isolated from the BTC dashboard on 3000/5050): **4000** web+API · **5433** Postgres · **6380** Redis.
- **Docs:** `CLAUDE.md` (the v2 blueprint + build status), this file, `docs/CODE_REVIEW_2026-07.md` (the deep review), `.env.example` (every knob, commented). Obsidian: `New Money/vault/EREBUS/`.

---

## 2. Architecture

- **Monorepo:** pnpm + Turborepo, TypeScript, source-only packages run via `tsx`.
- **DB:** Postgres 16 + pgvector (`VECTOR(1536)` everywhere — one embedding space for nodes, signals, articles, narratives, playbook patterns). Drizzle ORM; migrations in `packages/db/drizzle`, applied by `pnpm --filter @erebus/db migrate` on deploy (never automatic at boot).
- **API:** Hono mounted **inside Next 15** at `/api` (`apps/web/app/api/[[...route]]/route.ts`) — one web container serves UI + API. The web image serves a **compiled** Next build: source changes need an image rebuild (`docker cp` only helps the worker).
- **Worker:** `apps/worker/src/scheduler.ts` — timer ticks + the continuous-roam loop.
- **LLM:** `packages/agents/src/client.ts`. `LLM_PROVIDER=auto` → Anthropic first, OpenAI fallback on any error. Tiers: **deep = `claude-fable-5`** (genesis, dark genesis, game reads, ACH, expansion, playbooks) via the beta endpoint with server-side refusal fallback to Opus 4.8; **fast = `claude-haiku-4-5`** (matching, labels, NER, framing, ACH marks, verification). Fallbacks: gpt-4o / gpt-4o-mini. Costs are ledgered against the **served** model (`exploration_jobs`), and `callJSON` returns `{data, cost, offline, parsed, model}` so rows record what actually answered.
- **Embeddings:** `EMBEDDING_PROVIDER=openai` (`text-embedding-3-small`). `embed()` degrades to a deterministic hash-space vector when paused/keyless; **`embedStrict()` throws instead** and is the only function allowed to persist vectors.

### Packages
`db` (schema, migrate, settings, embeddings, vector, **budget governor**) · `agents` (LLM client, prompts, debate) · `core` (tree ops, greening, autonomy, scoring, verify, genesis, ACH) · `ingest` (RSS + signal↔node matching) · `market` (correlation) · `gametheory` · `shadowboard` · `gardener` · `evals` · `content` (profit engine) · **`loom`** (narrative intelligence). Apps: `web`, `worker`.

### Worker ticks (all `*_EVERY_MIN` tunable)

| Tick | Cadence | Gated by pause/hours? | What |
|---|---|---|---|
| ingest | 30m | yes | RSS → embed → judge vs nearest nodes → Bayesian greening |
| rematch | 45m | yes | re-sweep recent signals (idempotent via (signal,node) unique) |
| cycle | 60m | yes + autonomous | one bounded expansion cycle (`CYCLE_BUDGET_USD`) |
| genesis | 240m | yes + autonomous | 2 strategic + 2 dark root theories per tick |
| verify | 720m | yes + autonomous | source-verified resolution sweep + audit |
| market | 360m | yes | theory↔instrument mapping + market signals |
| garden / worldview | 12h / 24h | yes | prune/merge/decay; worldview snapshot |
| alerts | 10m | **no** (free) | derive operator alerts from events; Telegram if configured |
| loom | 15m | **no** (free) | wire + article ingestion, dual timestamps |
| loom-cluster | 60m | **no** (self-gated inside) | `runLoomPass()` — see §4 |
| loom-market | 360m | **no** (free) | `runLoomMarketPass()` — see §4 |
| continuous roam | self-loop | yes + autonomous + budget | branch back-to-back while enabled |

Two cross-process **advisory locks** serialize LOOM: `427001` (hourly pass) and `427002` (market pass). Never split work across a lock boundary — the review found double-written metrics when lifecycle ran outside it.

---

## 3. EREBUS core

**Forecast tree + greening.** Signals are embedded and matched to the nearest nodes; a fast-tier judge labels confirm/refute/neutral with a weight; `applyMatch` (`packages/core/src/greening.ts`) updates `nodes.probability` in **log-odds** (±`weight·LLR_SCALE` nats, `LLR_SCALE=0.5`, clamped [0.02, 0.98]); `confirmation` is the pure view `2p−1` that drives state (`speculative → corroborating → corroborated`, or `contradicted`); corroborated nodes latch `isLaunchPoint`. Terminal states (resolved / merged / dormant) are enforced — they never receive new evidence.

**Autonomy.** `settings.autonomous` gates cycle/genesis/verify; `settings.roam_continuous` runs a self-rescheduling loop (2s when productive, 12s backoff otherwise). Selection rotates on `last_expanded_at` and excludes `expand_blocked`, max-depth, and inert nodes. Every autonomously created branch is greened against existing signals immediately.

**Theory factory.** `generateRootTheories({dark,count})` births new roots from the signal stream — strategic (`origin=erebus`, ✦) and **dark** (`origin=shadow`, ⚡ — hidden agendas, cui bono, cover narratives, always falsifiable). Offline stubs are deleted, never shown. Explorer buttons + `POST /api/genesis`.

**Game-theory layer.** `POST /api/nodes/:id/game`: players/BATNA/dominant strategies, equilibrium + type, **stability [0,1]** → folded into state as **`tipping`** (confirming but fragile — the alpha); decision layer: focal point, leverage moves, no-regret action, reversal tripwire (fed into indicators). Roam is biased toward low-stability nodes.

**ACH + real calibration.** `POST /api/nodes/:id/ach` maintains 3–5 rival outcomes as a posterior; the stated outcome's mass folds into P. Resolution is **external** — `resolveByMarket()` or operator `PUT /api/nodes/:id/resolve` — with Brier `(p − actual)²`; `GET /api/calibration`. **Source-verified resolutions:** `POST /api/verify` / worker tick judges due theories against their own matched evidence (fast tier), auto-adjudicates at confidence ≥ 0.7, audits recent resolutions; 3-day backoff on `nodes.last_verified_at` (distinct from the gardener's `last_validated_at`).

**Shadow Board** (`/shadow`): deception read; may spawn a contested counter-forecast wired into the tree as a `tension` branch (⚡).

**Market correlation** (`/market`): 16-instrument catalog, Yahoo (Stooq is blank from the VPS IP); moves ≥ `MARKET_MOVE_PCT` over `MARKET_WINDOW_DAYS` become deterministic `source:"market"` signals.

**Alerts:** bell + optional Telegram; greened / tipping / contradicted / resolved / fragile / theory-born / disputed. **Operating hours:** optional UTC window gating paid ticks. **Content Studio** (`/studio`): script → images (`gpt-image-1`) → voice (ElevenLabs, optional) → ffmpeg MP4 — built and verified, deliberately de-prioritized by the operator in favor of theory generation. **Made** (`/made`): every EREBUS-authored branch grouped by root.

---

## 4. LOOM — narrative intelligence (`packages/loom`)

Spec: `LOOM_SPEC.md` (12 modules M1–M12, rules R1–R8). Built Phases 0–5; unbuilt items need paid vendors. The observable layers (propagation, positioning, crowd) are **measured**; intent is **inferred** and gets ACH treatment, ICD-203 estimative language, and mandatory falsifiers. UI: the **∿ Loom** tab (`/narratives`) — read-only spec-M12 card.

### The two passes
- **Hourly `runLoomPass()`** (lock 427001): embed → assign → recount → promote → label → **lifecycle** → entities → framing → intent (ACH) → forecasts → playbook matcher → **bridge to tree**. Every paid step is self-gated (`embedStrict`, `callJSON` pause + budget), so the pass degrades to its free work rather than failing.
- **6-hourly `runLoomMarketPass()`** (lock 427002, free): prices → detectors → insider proxy → regimes → event studies → placebo (daily) → flags → analogs → source graph → playbook decay → forecast resolution.

### Modules and their load-bearing contracts
- **M1 ingestion (Phase 0):** `published_at` (claimed) vs `first_seen_at` (observed) on every row — **R1**, the spine. `first_seen_at` is *our poll stamp*: articles from one pass land milliseconds apart in feed order, so **never rank outlets by it**. Wire feeds (PR Newswire, GlobeNewswire) + 28 outlet feeds (`LOOM_ARTICLE_FEEDS`; verified reachable from the VPS IP). Canonical URLs (http/https only — stored-XSS guard), text hashes. GDELT-via-BigQuery is stubbed behind `GDELT_BQ_*`.
- **M2 narratives (Phase 1):** incremental clustering — join the nearest narrative within a 14-day window at cosine ≥ `LOOM_SIM_THRESHOLD` (**0.70**, tuned on live pairs: the spec's 0.82 is unreachable on `text-embedding-3-small`), else seed a candidate; promote at ≥5 articles / ≥3 outlets; fast-tier label (attempt-capped, seed-title fallback). Running-mean centroid with the same-batch divisor tracked in memory. Lifecycle **seeding → amplifying → peak → decaying → dormant** with hysteresis; reignition resets the high-water mark; amplifying checks the decay band before the peak band. Hourly metrics + a transition log. Purity spot-check at launch: 12/12 clusters pure.
- **M3 entities (Phase 2):** fast-tier NER → company/country/commodity → tickers via SEC `company_tickers.json` + proxy-ETF maps → weighted exposure edges. **Conservative by design**: multi-CIK collisions and reverse-prefix subsidiary traps return *no* linkage (a wrong ticker poisons every downstream study); country/commodity are closed vocabularies (the LLM once filed a person as a country).
- **Event studies:** market model on **adjusted closes** (SPY, ≤120 trading days ending T−11, T = first_seen); CARs `[-10,-1]/[0,+1]/[+2,+10]`; the in-progress bar is never stored, so a CAR finalizes only on closed days.
- **M5 positioning + R4 (Phase 3):** vol_z, out-of-sample residual return (each day scored by a model fitted on `[k−131, k−11)`), EDGAR Form-4 burst proxy (parsed from `<entry>` blocks only). Regimes from VIX level + trend. **R4 is structural**: `placebo_pctl` is NOT NULL — a pre-positioning flag cannot exist without its regime-stratified placebo percentile (three regime nulls, 1000 draws each, truncated windows excluded).
- **M8 intent + M2 coordination (Phase 4):** framing slots (sampled, capped); coordination score with bootstrap CI (timing / text-sim / wire provenance / frame homogeneity — text-sim rebased on the cluster admission floor so membership isn't read as coordination, **R5**); ACH over fixed H1–H7, **least-inconsistent wins**, temperature-softmax → ICD-203 bands, confidence reported separately. **R2 is enforced at the single write path**: `persistJudgment()` throws without a distinct runner-up and ≥1 falsifier; beneficiaries each carry a falsifier (**R7**). Retry caps on every paid path (`label_attempts`, `ach_attempts`, `entities_scanned_at`, framing sentinel rows).
- **M11 forecasts + R6 (Phase 4):** append-only pre-registration (**R3**) of `lifecycle` / `market_move` / `playbook_match` claims, windows keyed on the observed transition (**R1**), regime + model version stamped; daily resolution → Brier; `GET /api/loom/scoreboard` marks a head **advisory** when its rolling Brier loses to climatology, and the card renders that instead of hit/miss.
- **M7 analogs (Phase 5):** precedents from LOOM's own history (the spec's GDELT backfill needs GCP), cosine in `[0.55, 0.85]` (above the ceiling is the *same* story). **A prior must measure exactly the claim it prices**: lifecycle counts amplifying→peak within 72h; market counts the raw N-day move on the *same instrument* in a direction declared from the target's own signal (letting analogs pick the side and report its own frequency makes a coin flip read 63%). Below `LOOM_ANALOG_MIN` regime-matched precedents the hand-set prior stands and the card says so.
- **M4 source graph + M10 negative space (Phase 5):** first-mover rate / wire dependence / lead time per outlet, ordered by **claimed** time with a minimum lead over the runner-up; rates need `LOOM_PRIOR_MIN_N` narratives and render "no prior yet" rather than 0%. Coverage asymmetry vs a leave-one-out country baseline; displacement (falling faster than own trend while corpus attention holds). Statistics about outlets, never evidence about a story (R5/R7).
- **M9 playbooks (Phase 4 pilot + Phase 5 automation):** `POST /api/loom/playbooks {theoryRef}` — a deep-tier red-team pass turns a theory into campaign watch-patterns (capped per theory; retired ones free their slot). Matching: **embedding route** (`pattern_embedding` cosine vs narrative centroid ≥ 0.5 — calibrated on 423 live pairs: mean 0.19, p99 0.57; every hit on-topic) plus a whole-word token route. Confidence is settled by **resolved** match outcomes, not match volume; bounded time decay. Pilot: 9 playbooks over three theories.
- **Bridge (LOOM → tree):** each *promoted* narrative becomes exactly one `signals` row (`source=loom`, embedding = centroid, dedup `loom:promoted:<id>`), judged by the existing matcher at `weightScale 0.5` — LOOM's feeds overlap EREBUS ingest, so member articles usually greened the node already; the narrative's marginal information is breadth. Emitted only when the judge can run (llm live, unpaused, within budget); 72h window, fresh-first; `loom` rows are excluded from resolution-verification evidence.

**Not built (vendor-gated):** options-flow detectors (`oi_jump` / `pc_skew` / `iv_pctl`, spec Q1), social velocity, contract odds (Kalshi/PM), GDELT GKG backfill (needs a GCP project). **Acceptance clocks running:** Phase 1 = 7 days unattended with sane transitions; **R8** = no capital touches a LOOM signal until a head completes a 90-day cycle beating its base rate — that clock has not started.

---

## 5. Safety and cost contracts (do not relax)

- **Pause kill-switch** (`settings.paused`): full stop on every paid call — LLM, embeddings, images.
- **Shared daily budget governor** (`@erebus/db/budget.ts`, enforced *inside* `agents.call()`): `DAILY_BUDGET_USD` (default `CYCLE_BUDGET_USD × 10`) caps every process — worker, web, Studio — from the `exploration_jobs` ledger; **fails closed** after 3 ledger-read failures.
- **Fallback output never persists.** `callJSON` returns `{data, cost, offline, parsed, model}`; every persist site checks `offline || !parsed` and skips. A stored fallback consumes a dedup slot forever.
- **Only `embedStrict()` persists vectors.** A hash-space vector in the cosine space is permanent poison.
- **One judgment per (signal, node)** — DB unique index; concurrent sweeps lose cleanly.
- **Auth fails closed** — blank `EREBUS_PASS` → 503 (`EREBUS_ALLOW_NO_AUTH=1` for local dev); constant-time compare; cross-site non-GET rejected.
- **API hygiene** — numeric params clamped, embeddings/centroids stripped from every response, 500s return an opaque ref.
- **Untrusted input** — feed text enters prompts through `untrusted()` (tag-stripped, truncated).
- **Append-only forecasts (R3)** — there is no update path; resolutions live in their own table.

### Known pre-existing issues (documented, not fixed)
- `applyMatch` is a read-modify-write without a transaction; two judges on one node within the same instant can drop one update (low probability, bounded effect).
- `judgePair` inserts the match row before `applyMatch`; a crash between the two loses that evidence and the dedup blocks a retry.
- `loom_articles.lang` is never populated (reach_langs always 0).
- Judge weights for market signals are deterministic, not calibrated.

---

## 6. Operating it

**Toggles:** header **Pause** (all spend), Explorer **Autonomous** (cycle/genesis/verify), **Continuous** (roam loop), `PUT /api/hours` (operating window). LOOM runs regardless of the autonomous toggle.

**Deploy** (from the local repo):
1. `tar --exclude=node_modules --exclude=.next --exclude=.git --exclude=.env --exclude=.turbo -czf /tmp/erebus-deploy.tgz .`
2. `scp` to `/tmp` on the VPS; `cd /opt/erebus && tar -xzf /tmp/erebus-deploy.tgz` (preserves `.env`).
3. `docker compose -f docker-compose.prod.yml build web worker`
4. **If there is a migration:** `stop worker web` first (index-creating migrations race a live worker), then `run --rm web sh -lc 'cd /app && pnpm --filter @erebus/db migrate'`.
5. `docker compose -f docker-compose.prod.yml up -d web worker`
`docker-compose.prod.yml` passes the whole `.env` via `env_file`, so new knobs need only a restart.

**Key hand-off (never paste keys in chat):** fill `C:\Users\jrell\OneDrive\Desktop\erebus-keys.env` (`ANTHROPIC_API_KEY=` / `OPENAI_API_KEY=`) and say **"keys ready"**. The assistant copies it to the VPS without reading it, merges only non-empty lines into `/opt/erebus/.env` (chmod 600), restarts, verifies with one cheap call, and shreds the temp copies. A key that has appeared in a transcript must be rotated.

**Health & spot checks:**
- `GET /api/health` (llm live? paused?), `GET /api/loom/status` (corpus + Phase 0/1 acceptance metrics), `GET /api/loom/scoreboard` (R6), `GET /api/calibration`.
- Manual passes: `POST /api/loom/ingest`, `POST /api/loom/cluster` (hourly pass), `POST /api/loom/market`, `POST /api/genesis {dark,count}`, `POST /api/verify`.
- Worker log lines: `[scheduler] <tick> ok (ms) {…}`; `[llm] anthropic failed (401 …) falling back` means the key is dead.

**Backups:** nightly `pg_dump` to `/opt/erebus-backups` (keep 14).

**Key env vars** (`/opt/erebus/.env`, chmod 600): `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `EREBUS_USER`/`EREBUS_PASS`, `POSTGRES_PASSWORD`, `LLM_PROVIDER=auto`, `OPUS_MODEL`/`SONNET_MODEL`, `EMBEDDING_PROVIDER=openai`, `DAILY_BUDGET_USD`/`CYCLE_BUDGET_USD`, `*_EVERY_MIN`, `NEWS_SOURCES`, `LOOM_ARTICLE_FEEDS`/`LOOM_WIRE_FEEDS`, `LOOM_SIM_THRESHOLD=0.70`, and the LOOM tuning knobs documented in `.env.example` (thresholds, caps, priors, analog/bridge/playbook settings, `GDELT_BQ_*`).

---

## 7. Roadmap

1. **Replace the Anthropic key** — until then the deep tier is gpt-4o and Fable never serves.
2. **Let the clocks run** — Phase 1 acceptance (7 days) and the R6/R8 calibration cycle only accrue with time and resolved forecasts.
3. **Corpus breadth keeps paying** — most Phase 5 statistics are gated on outlets and precedent depth; add feeds before adding code.
4. **Vendor decisions** — options-flow (~$75–150/mo) unlocks three detectors; a GCP project unlocks the GDELT backfill and the spec's analog matcher.
5. Later: equilibrium-break/tripwire alerts, value-of-information ranker, fractional-Kelly read-only sizer (never auto-trade), pre-mortem as a node op, Content Studio auto-publish, self-play equilibrium simulation.

---

## 8. Security notes
- Never commit `.env` or keys (gitignored). Keys live only in `/opt/erebus/.env`.
- Any key pasted into chat is compromised — rotate it.
- Dashboard is Basic-auth only, no firewall, by design.

---

## 9. Change log (this branch)

| Commit | What |
|---|---|
| `4c9cf64` | docs: playbook matcher calibration, key status |
| `4c74fca` | LOOM→tree bridge, 28-feed corpus, playbook pilot + embedding matcher, served-model plumbing |
| `fa3686a` | LOOM Phase 5: analogs, source graph, negative space, playbook automation (29 review findings fixed) |
| `b5fd78e` | LOOM Phases 2–4: entities, event studies, positioning/placebo, ACH intent, forecasts (37 findings fixed) |
| `1470134` | LOOM Phase 1: clustering, lifecycle, `/narratives` (9 findings fixed) |
| `4b192fe` | Hardening pass (70 findings) + LOOM Phase 0 |
| earlier | Game theory, Bayesian greening + ACH + calibration, genesis/dark genesis, alerts, verify sweep, Content Studio, Market, Made |

Every phase shipped only after an adversarial multi-agent review of the diff with two-vote verification per finding; the review reports are the source of the contracts in §5.
