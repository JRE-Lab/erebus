# EREBUS — Project Handoff

A forward-branching **forecast tree that greens as reality confirms it**, plus a
content profit engine and a strategic (game-theory) decision layer. Each node is
a forecast (question + not-yet-happened outcome + indicators + falsifiers +
horizon). Incoming news + market signals are matched to indicators and "green
up" branches (`speculative → corroborating → corroborated`, or `contradicted`);
corroborated nodes become launch points to branch further or to turn into
content.

---

## 1. Where it lives

- **Code:** `C:\Users\jrell\OneDrive\Desktop\JRE-Lab\erebus` (git branch `forecast-engine`; remote `github.com/JRE-Lab/erebus`).
- **Production:** VPS `root@159.203.86.148`, dir `/opt/erebus`, `docker compose -f docker-compose.prod.yml`.
- **Dashboard:** http://159.203.86.148:4000 — Basic-auth `erebus` / `imitate` (`EREBUS_USER`/`EREBUS_PASS` in `/opt/erebus/.env`).
- **Ports** (isolated from the BTC dashboard on 3000/5050): **4000** web+API, **5433** Postgres, **6380** Redis.

---

## 2. Architecture

- **Monorepo:** pnpm + Turborepo. TypeScript everywhere, source-only packages (run via `tsx`).
- **DB:** Postgres 16 + pgvector (VECTOR 1536). Drizzle ORM. Migrations in `packages/db/drizzle` applied by `pnpm --filter @erebus/db migrate` (NOT automatic at boot — run on deploy).
- **API:** Hono mounted **inside Next 15** at `/api` (`apps/web/app/api/[[...route]]/route.ts`) — one web container serves UI + API.
- **Worker:** `apps/worker` — autonomous scheduler (`src/scheduler.ts`) running ingest/rematch/cycle/garden/worldview/market on timers + the continuous-roam loop.
- **LLM:** multi-provider (`packages/agents/src/client.ts`). `LLM_PROVIDER=auto` → **Anthropic first**, falls back to **OpenAI** (`gpt-4o`/`gpt-4o-mini`) on any error. **Tiers: deep = `claude-fable-5`** (genesis, dark genesis, game reads, ACH, expansion — Anthropic's most capable model, $10/$50 per MTok) **, fast = `claude-haiku-4-5`** (matching, directions, verification — $1/$5). Fable runs through the beta endpoint with a **server-side refusal fallback to Opus 4.8**; a whole-chain refusal throws so the OpenAI fallback still applies. No thinking/sampling params are sent (Fable requires omission). Costs are ledgered against the *served* model with prefix-match pricing. Every call is pause-guarded and cost-logged to `exploration_jobs`. Change tiers any time via `OPUS_MODEL`/`SONNET_MODEL` in `/opt/erebus/.env` + restart.
- **Embeddings:** `EMBEDDING_PROVIDER=openai` on the VPS (`text-embedding-3-small`, 1536); deterministic offline fallback exists.

### Packages
`db` (schema/migrate/settings/embeddings/vector + **budget governor**) · `agents` (LLM client + prompts + debate) · `core` (tree ops, greening state machine, autonomy/roam, scoring, verify) · `ingest` (RSS + signal↔node matching) · `market` (correlation) · `gametheory` (strategic layer) · `shadowboard` (deception) · `gardener` (prune/merge) · `evals` · `content` (profit engine) · **`loom` (narrative intelligence, Phases 0-5)**. Apps: `web`, `worker`.

---

## 3. Features

### Forecast tree + greening
News/market signals are embedded, matched to the nearest nodes, and a Sonnet judge labels confirm/refute/neutral; `applyMatch` moves a confirmation scalar that drives state. Autonomously-roamed/expanded branches are now greened against existing signals immediately (in the cycle, `/roam`, `/nodes/:id/expand`, and the continuous loop) — previously they greened only by chance.

### Autonomy & Continuous roam
- **Autonomous toggle** (`settings.autonomous`): gates the hourly `cycle` (Opus expansion, capped at `CYCLE_BUDGET_USD`).
- **Continuous roam** (`settings.roam_continuous`, Explorer toggle): a self-rescheduling worker loop that branches back-to-back (~2s when productive) — pause-aware, gated by the autonomous toggle, capped by the daily budget. Endpoints `GET/PUT /api/roam/continuous`.

### Content Studio (`/studio`) — profit engine
Per corroborated node: **script + storyboard** (Anthropic) → **images** (OpenAI `gpt-image-1`, 1024×1536 — NOT dall-e-3, which the project key rejects) → **voice** (ElevenLabs, optional) → **video** (ffmpeg, 1080×1920 MP4). Each stage independently runnable. Assets persist on the `erebus_content` volume (`CONTENT_DIR=/app/content`), streamed from `/api/content/file/:name`. ffmpeg is in the web image.

### Market correlation (`/market`)
16-instrument catalog (oil/gas/metals/indices/sector ETFs/VIX/dollar/bonds/BTC). Free no-key feeds: **Stooq primary → Yahoo fallback** (Stooq returns blank from the VPS IP, so Yahoo serves). Theories are LLM-mapped to instruments (`node_instruments`); a move ≥`MARKET_MOVE_PCT` (4%) over `MARKET_WINDOW_DAYS` (5) becomes a deterministic `source:"market"` signal that confirms (aligned) or refutes (opposed) — integrated greening. Worker `market` tick (6h) + `Map theories` / `Refresh + grade` buttons.

### EREBUS-made theories (`/made`)
Every `origin="erebus"` branch grouped under its root theory; cards deep-link into the Explorer via `/?focus=<root>&node=<id>`.

### Game-theory depth (the strategic layer)
`POST /api/nodes/:id/game` runs a **Game Read** (Opus): players (payoff ranking, BATNA, dominant strategy, patience), game type, predicted equilibrium + type, **equilibrium-stability [0..1]**, and "outcome IS/IS NOT the equilibrium" — plus a **Decision layer** (Sonnet): focal point, leverage moves, no-regret action, **reversal tripwire** (fed back into the node's indicators). Stored in `game_reads`; stability is denormalized onto `nodes.stability` and folds into state: a confirming-but-fragile node becomes **`tipping`** (violet) — *the real alpha*. Autonomous roam is biased toward low-stability nodes (probe the knife-edge). Shown in a Game Read panel in NodeDetail.

### Probability, ACH & calibration (the analytical core)
- **Bayesian greening:** `nodes.probability` is updated by **log-odds** — each signal match contributes ±`weight*LLR_SCALE` nats; `confirmation` (the [-1,1] state/UI scalar) is a pure view (`2p-1`). Sigmoid gives natural diminishing returns near certainty. `setProbability()` lets ACH set P directly. (`packages/core/src/greening.ts`)
- **ACH** (`POST /api/nodes/:id/ach`): tracks 3–5 mutually-exclusive rival outcomes as a posterior distribution; the stated outcome's mass folds into the node's P(outcome); flags when reality is selecting a *different* equilibrium. Shown as a bar chart in NodeDetail. (`packages/core/src/ach.ts`)
- **Real calibration:** forecasts no longer self-grade. They resolve against **external truth** — `resolveByMarket()` (realized instrument move vs expectation, horizon-anchored) or operator adjudication (`PUT /api/nodes/:id/resolve {happened}`). Brier = `(probability − actual)²`; `GET /api/calibration` returns resolved count / mean Brier / base rate (shown in the Explorer stat row). Adjudication is idempotent. (`packages/core/src/scoring.ts`, `packages/market/src/resolve.ts`)

### Genesis & dark theories (the theory factory)
EREBUS births NEW root theories from the signal stream — no longer only expanding existing ones. `generateRootTheories({dark,count})` (`packages/core/src/genesis.ts`): one Opus call proposes theories from recent signals (existing roots excluded + local near-dup guard over ALL roots), each becomes a root via `createForecast` (origin `erebus`, or **`shadow` for dark theories** — the disciplined-tradecraft layer: hidden agendas, cui bono, cover narratives, always falsifiable). Newborns are greened via `matchNode` immediately; offline stubs are deleted, never shown. Explorer buttons **✦ Genesis / ⚡ Dark genesis** + `POST /api/genesis`; worker `genesis` tick every `GENESIS_EVERY_MIN` (240) births 2 strategic + 2 dark per tick (budget re-checked between batches). Dark theories are marked ⚡ violet everywhere (Explorer roots, Made tab, OriginBadge).

### Alerts
`alerts` table (migration 0006) + worker tick (10m, **ungated** — runs even paused/off-hours since it's free) derives operator alerts from provenance events: greened / tipping / contradicted / resolved / fragile-equilibrium / theory-born. Watermark advances to the last processed event's DB timestamp (backlog- and clock-skew-safe); first run initializes silently (no historical flood); per-(node,kind) dedup 24h; seen alerts pruned after 30d. UI: bell with unseen badge in the Explorer (click an alert → jumps to the node). Telegram push activates automatically if `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` are set in `.env`.

### Operating hours
`settings.operating_hours` `{on,startHour,endHour}` (UTC) — a worker-side window gating all paid ticks AND the continuous-roam loop; orthogonal to the manual Pause switch. `GET/PUT /api/hours`. Off by default (always-on within budgets).

### Shadow Board (`/shadow`)
Deception/tradecraft read; can spawn a contested counter-forecast — now **connected into the tree** (`parentId` = source, `origin:"shadow"`, ⚡ branch label) and rendered in NodeDetail's "Strategic links".

### Source-verified resolutions
`POST /api/verify` / Explorer **Verify all** button + worker `verify` tick (12h): sweeps past-horizon theories, has the fast tier judge happened / did-not-happen / unclear against the node's own matched evidence, resolves with a Brier score. Per-node 3-day backoff via `nodes.last_verified_at` (migration 0008 — deliberately separate from `last_validated_at`, which is the gardener's decay clock).

### LOOM (narrative intelligence, Phases 0–1)
`packages/loom` — tracks *how stories move*, not just what happened.
- **Phase 0 (ingestion):** R1 dual timestamps on everything: `published_at` (claimed) vs `first_seen_at` (observed). Ingests **wire releases** (PR Newswire, GlobeNewswire) + **outlet articles** (BBC / Al Jazeera / Guardian world; override via `LOOM_WIRE_FEEDS`/`LOOM_ARTICLE_FEEDS`), canonical-URL (http/https only — XSS guard) + text-hash deduped into `loom_wire_releases`/`loom_articles` (migration 0007). Free. Worker `loom` tick 15m (ungated); `GET /api/loom/status`, `POST /api/loom/ingest`. GDELT-via-BigQuery stubbed behind `GDELT_BQ_ENABLED=1` + `GDELT_BQ_PROJECT` + `GOOGLE_APPLICATION_CREDENTIALS`.
- **Phase 1 (narratives, migration 0009):** hourly `loom-cluster` worker tick runs **`runLoomPass()`** — embed (via `embedStrict`, which *throws* rather than ever storing a hash-space fallback vector) → incremental assignment (join nearest narrative in a trailing 14-day window at cosine ≥ `LOOM_SIM_THRESHOLD` 0.82, else seed a candidate; same-batch running-mean divisor tracked in memory) → promote (≥5 articles / ≥3 distinct outlets) → fast-tier LLM label (offline-safe; real failures capped at `LOOM_LABEL_MAX_ATTEMPTS` then seed-title fallback) → **lifecycle machine** seeding→amplifying→peak→decaying→dormant with hysteresis, reignition (max-velocity reset), hourly `loom_narrative_metrics` rows and a `loom_narrative_transitions` log. The whole pass holds ONE pg advisory lock (427001) across processes. UI: read-only **`/narratives`** tab (∿ Loom in the nav) with state filters and a per-narrative drawer (articles + lifecycle log). API: `GET /api/loom/narratives[?state=&limit=]`, `GET /api/loom/narratives/:id`, `POST /api/loom/cluster`. Cost ≈ $0.001/day embeddings + a few cents of labels. Phase 1 acceptance gate: 7 days unattended + sane transitions on manual review + ~80% cluster purity spot-check.
- **Phases 2–4 (migration 0010):** the hourly pass now runs **`runLoomPass()` = cluster → lifecycle → entities → framing → intent → forecasts → playbook matcher** under one advisory lock (427001), and a separate free **`loom-market` tick (6h, lock 427002)** runs prices → detectors → insider proxy → regimes → event studies → placebo → flags → forecast resolution.
  - **M3 entities:** fast-tier NER per promoted narrative → canonical entities (company/country/commodity) → tickers via SEC `company_tickers.json` (no key) and static country/commodity proxy-ETF maps → weighted exposure edges. Resolution is deliberately conservative: ambiguity (multi-CIK collisions, subsidiary prefix traps) yields NO linkage rather than a wrong ticker.
  - **Event studies:** market model `r_i = α + β·r_m` (SPY, ≤120 trading days ending T−11, **T = first_seen**), CARs `[-10,-1]/[0,+1]/[+2,+10]`; prices are **adjusted closes** and the in-progress bar is never stored, so a CAR only finalizes on closed days.
  - **M5 positioning:** vol_z, residual return (model fitted strictly out-of-sample), and an EDGAR Form-4 burst proxy; **R4 is enforced structurally** — `placebo_pctl` is NOT NULL, so a pre-positioning flag cannot exist without its regime-stratified placebo percentile. Daily 3-state regime conditioner from VIX level + trend.
  - **M8 intent:** framing slots (sampled, capped) → coordination score with bootstrap CI (timing/text-sim/**wire provenance**/frame homogeneity, text-sim rebased on the cluster admission floor so membership similarity isn't read as coordination — R5) → ACH over the fixed H1–H7 taxonomy, **least-inconsistent wins**, ICD 203 bands, confidence reported separately. **R2 is enforced at the single write path**: `persistJudgment()` throws without a runner-up and ≥1 falsifier, so no judgment row (and therefore no card section) can exist without them. Beneficiaries each carry their own falsifier (R7).
  - **M11 forecasts:** append-only pre-registration (R3) of `lifecycle` / `market_move` / `playbook_match` claims, each stamped with regime + model version, windows keyed on the observed transition (R1); daily resolution → Brier; `GET /api/loom/scoreboard` compares each head's rolling Brier to its climatology and marks losers **advisory**, which the card renders instead of green/red chips (R6).
  - **M9 playbooks (pilot):** `POST /api/loom/playbooks {theoryRef}` runs a deep-tier red-team pass turning an EREBUS theory into machine-matchable campaign watch-patterns; matches are pre-registered and scored. Idempotent per theory.
  - API: `POST /api/loom/market`, `GET /api/loom/scoreboard`, `POST /api/loom/playbooks`. UI: the full spec-M12 card (frame chips, origin trace, intent with runner-up + falsifiers, exposure + CARs, placebo-controlled flags, forecast status strip).
  - **Phase 5 (migration 0011):** the free half of the spec's v2 tier, folded into the same two passes.
    - **M7 analogs** (`analogs.ts`): the empirical prior. Precedents come from LOOM's OWN history (the spec's GDELT backfill needs a GCP project), matched by centroid cosine in `[0.55, 0.85]` — the ceiling matters because anything above the cluster threshold is the SAME story, not a precedent. **An analog prior must measure exactly the claim it prices:** the lifecycle prior counts amplifying→peak within 72h (the resolution predicate itself, not time since the first article), and the market prior counts the raw N-day move on the SAME instrument in a direction declared from the target's own signal — choosing the analogs' majority side and reporting its frequency makes a coin flip read 63%. Below `LOOM_ANALOG_MIN` (5) regime-matched precedents the hand-set prior stands and the card says so.
    - **M4 source graph** (`sourcegraph.ts`): first-mover rate, wire dependence, and lead time per outlet. Ordering uses **claimed publish time**, never `first_seen_at` — our poll stamps every article of an ingest pass milliseconds apart in feed order, so ranking by it measured our own feed list. A narrative only counts when the winner's lead beats `LOOM_LEAD_MIN_GAP_MIN`; rates need `LOOM_PRIOR_MIN_N` narratives before they render, and an outlet with no prior shows "no prior yet", not 0%.
    - **M10 negative space:** coverage asymmetry vs a **leave-one-out** country baseline (including a story in its own expectation lets it define the norm it's judged against) and displacement (falling faster than its own trend *while corpus attention holds up*). One row per (narrative, kind), upserted.
    - **M9 automation:** playbook confidence is settled by **resolved** playbook_match outcomes, not match volume (paying out on match count selects for the spammiest patterns); matching requires whole-word hits on ≥4-char terms; time decay is bounded so one long gap can't wipe the library; retired playbooks stop matching but don't consume the per-theory generation cap.
    - **Narrative → tree bridge** (`bridge.ts`): the spec's "LOOM feeds the theory tree." Each PROMOTED narrative becomes exactly one `signals` row (source `loom`, embedding = the narrative centroid, dedup `loom:promoted:<id>`) and is judged + Bayesian-greened by the existing matcher — so it shows up in NodeDetail evidence like any signal. Weight is scaled by `LOOM_BRIDGE_WEIGHT_SCALE` (0.5) because LOOM's feeds overlap EREBUS ingest and the member articles usually greened the node individually already; only promotions ≤ `LOOM_BRIDGE_MAX_AGE_H` (72h) old are bridged, fresh-first; the row is only written when the judge can actually run (llm live, unpaused, within budget). `loom` rows are excluded from resolution-verification evidence (derived, not primary).
    - Feeds: `LOOM_ARTICLE_FEEDS` on the VPS now carries 28 feeds (EREBUS's 13 + 15 world outlets verified reachable from the VPS IP); the domain→country map in `sourcegraph.ts` covers ~45 domains.
    - **Playbook matcher (embedding route):** generated patterns are abstract ("alliance strengthening", "government spokespeople"), so token matching never fires. Each playbook now carries a `pattern_embedding` (migration 0012) and matches when cosine vs a narrative centroid ≥ `LOOM_PLAYBOOK_EMBED_MATCH` (0.5). Calibrated live on 9 playbooks × 47 narratives (423 pairs): mean 0.19, p90 0.32, p99 0.57, max 0.62 — 0.5 is the ~97th percentile and every hit was on-topic (11 Iran/oil narratives for the Iran/oil theory, none across theories). A narrative can match several playbooks of one theory; each is a separate pre-registered prediction.
    - Still unbuilt (need paid vendors): options-flow detectors (`oi_jump`/`pc_skew`/`iv_pctl`, spec Q1 ~$75-150/mo) and social velocity. GDELT backfill needs a GCP project.

### Cost control
- **Pause kill-switch** (`settings.paused`, header button): instant full stop on ALL paid calls (LLM + embeddings + images).
- **Shared daily budget governor** (`@erebus/db/budget.ts`, enforced inside `agents.call()` itself): `DAILY_BUDGET_USD` (default `CYCLE_BUDGET_USD × 10`) caps **everything** — worker ticks, web API, Studio images/voice — across all processes, reading the `exploration_jobs` ledger. **Fails closed** after 3 consecutive ledger-read failures. `CYCLE_BUDGET_USD` still bounds a single autonomous cycle.

### Hardening (2026-08 review PR)
An 80-agent adversarial review (report: `docs/CODE_REVIEW_2026-07.md`) drove a hardening pass. The load-bearing contracts:
- **`callJSON` returns `{data, cost, offline, parsed}`** — every persist site checks `offline || !parsed` and *skips/blocks* instead of writing fallback stubs (matching, game reads + decisions, shadow reads, debate rounds, market mapping, genesis, expansion). Paused/offline operation no longer poisons the evidence corpus.
- **Expansion is failure-aware:** parse failure / offline / embedding outage → `expand_blocked` with a reason, `MAX_CHILDREN=12` cap, `last_expanded_at` rotation; embeddings retry 429/5xx with backoff then **throw** (never silently store hash vectors).
- **Auth fails closed:** blank `EREBUS_PASS` → 503 (set `EREBUS_ALLOW_NO_AUTH=1` for local dev); constant-time compare; cross-site non-GET requests are rejected (CSRF).
- **API hygiene:** every numeric param clamped, embeddings stripped from all responses, 500s return an opaque ref (real error server-side only).
- **Untrusted-input wrapping:** signal titles/summaries/evidence go into prompts through `untrusted()` (tag-stripped, truncated) — prompt-injection dampening.

---

## 4. Operating it

- **Resume / spend:** the system runs $0 while paused. To go live: header **Pause** off, **Autonomous** on (and **Continuous** on for back-to-back roaming). The $15/day cap bounds the autonomous loop.
- **Deploy** (from local repo):
  1. `tar czf /tmp/erebus-deploy.tgz --exclude node_modules --exclude .next --exclude .git --exclude .env .`
  2. `scp` to `/tmp` on the VPS, `tar xzf … -C /opt/erebus` (preserves `.env`).
  3. `docker compose -f docker-compose.prod.yml build web worker`
  4. `docker compose -f docker-compose.prod.yml stop worker web` — **stop BEFORE migrating**: index-creating migrations race a live worker.
  5. `docker compose -f docker-compose.prod.yml run --rm web sh -lc 'cd /app && pnpm --filter @erebus/db migrate'`
  6. `docker compose -f docker-compose.prod.yml up -d web worker`
- **Backups:** nightly `pg_dump` to `/opt/erebus-backups` via cron (keep 14).

### Key env vars (`/opt/erebus/.env`, chmod 600)
`ANTHROPIC_API_KEY`, `OPENAI_API_KEY` (LLM + images + embeddings), `EREBUS_USER`/`EREBUS_PASS` (blank pass = 503; `EREBUS_ALLOW_NO_AUTH=1` for open local dev), `POSTGRES_PASSWORD`, `EMBEDDING_PROVIDER=openai`, `LLM_PROVIDER=auto`, budgets/cadences (`*_BUDGET_USD`, `*_EVERY_MIN`), `OPENAI_IMAGE_MODEL=gpt-image-1`, `ELEVENLABS_API_KEY` (optional — voice), `MARKET_MOVE_PCT`/`MARKET_WINDOW_DAYS` (optional), LOOM: `LOOM_INGEST_EVERY_MIN` / `LOOM_WIRE_FEEDS` / `LOOM_ARTICLE_FEEDS` / `GDELT_BQ_*` (optional).

⚠️ **Anthropic key status:** the 08-24 key was rotated (revoked) as planned, so the VPS is 401 again and everything runs on the OpenAI fallback — Fable is NOT serving until a new key is installed. Rotate any key that has been pasted into a chat transcript — install replacements via the `erebus-keys.env` hand-off flow (fill the file, say "keys ready"; do NOT attach it to chat).

---

## 5. Roadmap (designed, not yet built)

From the game-theory design panel + subsystem audit + LOOM spec, in priority order:
- **LOOM calibration (the gate that matters)** — every forecast head still runs hand-set priors until the analog pool reaches `LOOM_ANALOG_MIN` regime-matched precedents, which needs corpus history. R6 pulls a losing head to advisory; R8 says no capital touches a LOOM signal until a head completes a 90-day cycle beating its base rate. That clock has not started.
- **LOOM vendor-gated items** — options-flow detectors (spec Q1, ~$75-150/mo) and social velocity; GDELT GKG backfill (spec Q2) needs a GCP project.
- **More feeds** — most Phase 5 statistics (first-mover, coverage asymmetry, analog depth) are gated on corpus breadth; 3 outlets is the binding constraint, not the code.
- **Equilibrium-break & tripwire alerts** — a live rail that fires when a corroborated node destabilizes or a decision's tripwire greens.
- **Value-of-Information ranker** — roam toward the most decision-relevant uncertainty, not the most-confirmed node.
- **Position sizer** — fractional-Kelly read-only sizing for instrument-linked nodes (never auto-trade).
- **Pre-mortem / red-team** as a first-class node op; **strategic edge auto-population** (best_response_to/deters) during expansion.
- **Auto-publish** Content Studio shorts to YouTube/TikTok/IG (needs platform API keys).
- **Visionary:** self-play equilibrium simulation, reflexivity engine, systemic graph dynamics (feedback loops/cascades), counterfactual "pin a hypothetical signal" sandbox.

---

## 6. Security notes
- Never commit `.env` or keys (gitignored). Keys live only in `/opt/erebus/.env`.
- If keys are ever pasted into chat, rotate them — chat history is compromised.
- Dashboard is Basic-auth only (no firewall, by design).
