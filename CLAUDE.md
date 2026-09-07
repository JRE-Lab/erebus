# EREBUS v2 — Core Blueprint

**Emergent Recursive Exploration & Branching Understanding System**

> The engine is a **forward-branching forecast tree that greens as reality confirms it.** EREBUS gazes into the void, predicts outcomes that haven't happened, branches new questions off those predictions, and lets incoming news light up the paths that come true. Clean-slate rebuild. The discipline (provenance, governors, gardener) serves the exploration — never the reverse. Drop in the repo root (rename to `CLAUDE.md` for auto-load) and build **phase by phase, gate by gate**. UI polish and the wider feature set are deferred to §12 Roadmap.

---

## 0. How to use this with Claude Code

1. Read **§1 the engine** and **§2 reconciliation** before any code — they define the core loop and override every instinct toward caution.
2. Build in the order of **§10 Phased plan**. Each phase has a hard verification gate: pass it end-to-end before moving on.
3. The two halves of the core loop — the **Forecast Tree** (§3.1) and the **Corroboration Engine** (§3.2) — come first. Nothing else matters until those work together.
4. Confirm or override **§13 defaults** before Phase 0.

---

## 0.5 Build status (2026-09-07)

This blueprint has been **built**. Everything in §10 is live on the VPS; the
operational truth is `HANDOFF.md` (read that first for state, access, and
contracts). Deviations from §13 defaults, as resolved:

| Default (§13) | Resolved as |
|---|---|
| Embeddings TBD | OpenAI `text-embedding-3-small`, `VECTOR(1536)` everywhere |
| Tiering Opus / Sonnet | deep = `claude-fable-5` (beta endpoint, Opus 4.8 refusal fallback), fast = `claude-haiku-4-5`; OpenAI gpt-4o / gpt-4o-mini fallback on any error |
| News source TBD | RSS (`NEWS_SOURCES`, 13 feeds) for the tree; 28 feeds for LOOM (`LOOM_ARTICLE_FEEDS`) |
| Worker: cron + Redis | timer ticks in `apps/worker`; Redis present, BullMQ not adopted |
| Content: ElevenLabs + Remotion | ElevenLabs (optional) + **ffmpeg** (Remotion dropped) |
| Governors `CYCLE_BUDGET_USD` | plus a **shared daily governor** enforced inside every LLM call, fail-closed |

| §10 phase | Status |
|---|---|
| 0–3 Foundation, tree, expansion, corroboration | done — corroboration is a **log-odds Bayesian** update, not a scalar |
| 4–5 Debate/lenses, synthesize/reconcile | done |
| 6 Shadow Board | done, counter-forecasts wired into the tree |
| 7 Autonomous worker + governors | done; hardened (selector rotation, terminal-state enforcement, fail-closed budget) |
| 8–9 Gardener, worldview | done |
| 10 Explorer UI | done (+ Made, Market, Shadow, Studio, **∿ Loom** tabs) |
| 11 Content Studio | done and verified end-to-end; de-prioritized by the operator |

Beyond the blueprint: **game-theory decision layer** (equilibrium stability →
`tipping` state), **real external calibration** (Brier against markets /
operator / source-verified judge), **theory factory** (genesis + dark genesis),
alerts, operating hours, and **LOOM** — a narrative-intelligence layer
(`LOOM_SPEC.md`, Phases 0–5 built) that clusters the story stream, attributes
intent as competing hypotheses under R1–R8 discipline, pre-registers scored
forecasts, and feeds promoted narratives back into the tree as evidence.

Known operator-side gaps at this date: Anthropic key rotated and not yet
replaced (deep tier on fallback); vendor decisions pending for options-flow
data and a GCP project (GDELT).

---

## 1. The engine — prime directive

EREBUS is a persistent analytical intelligence that thinks when you're not looking. **The core loop:**

> Gaze into the void → ask a **question** → answer it with an **outcome that has not happened yet** (a forecast) → branch *new* questions off that forecast → answer those with further outcomes → recurse forward into the future. **Every question-and-answer is its own branch** of decision and logic.

Running alongside it, the feedback loop that gives the tree life:

> As news funnels in and **confirms** a branch's predicted outcome, that branch **greens up** on a gradient. When it greens to **corroborated**, it becomes solid ground — and the next branches launch from *there*, building forward on confirmed reality instead of pure speculation.

The directive: *see further, not be right.* Uncertainty is a map (the thickest fog marks where the most important hidden things are); contradictions are fuel; speculation is legitimate; **the world is the judge.**

The five core systems:

- **Forecast Tree** (§3.1) — the dense, granular, forward-recursing body of question→outcome branches. The big deal.
- **Corroboration Engine / "the green"** (§3.2) — ingests reality and lights up the branches it confirms. The central feedback loop.
- **Shadow Board** (§3.3) — intelligence-tradecraft deception analysis.
- **Dark Perspective** (§3.4) — the unflinching stance.
- **Profit engine** (§3.5) — content that funds the system; intelligence that sharpens your own decisions.

---

## 2. Prime directive vs. discipline — RECONCILED

v1 lesson: a system told only "see further" fools itself; a system told only "stay grounded" strangles the exploration that is its reason to exist. The resolution — and the correction from the last pass:

1. **Speculate freely, forward.** Nodes are forecasts of things that haven't happened. EREBUS NEVER refuses to predict for lack of evidence. Evidence-free forward branching is the engine, not a bug.
2. **Reality is the primary judge, not debate.** A node's headline signal is **confirmation** — how much incoming news matches its predicted outcome. That's what greens the tree. Internal **confidence** (from debate) is secondary: it sharpens forecasts and hardens falsifiers, it does not decide truth.
3. **Greening = grounding = calibration — one thing.** As confirming signals land, a node moves `speculative → corroborating → corroborated`; its grounding label rises the same way; and when its horizon passes, the Brier score writes itself. Three concepts I'd split are one mechanism.
4. **The Gardener prunes dead wood, never speculation.** Prunable only if dormant past TTL, contradicted/falsified, or duplicate — never for being unproven.
5. **Doubt is applied by argument, after the idea exists — never as a gate.** The Adversarial/Heretic lens attacks forecasts and forces good indicators; it never prevents one.

EREBUS's fearlessness is **analytical** — it reasons without flinching about power, deception, and uncomfortable geopolitical/economic realities, the way serious intelligence and market analysis do.

---

## 3. Core systems

### 3.1 The Forecast Tree (the big deal)

A dense, branching, forward-recursing tree. The atomic unit is **not a fat theory — it's a question and its forecast.** A node carries:

- `question` — what it asks ("Does the US escalate with Iran in the next 6 months?")
- `outcome` — the speculative answer that **hasn't happened yet** ("Limited US strikes on Iranian oil infrastructure; no ground commitment")
- `indicators` — observable signals that would **confirm** the outcome (greens it)
- `falsifiers` — what would **refute** it (reds it)
- `horizon` — roughly when the outcome resolves / becomes checkable

**Branching = forward recursion.** Expanding a node means: take its `outcome`, ask *"if this happens, what questions follow?"*, and spawn each follow-on question as a **child forecast** with its own outcome, indicators, falsifiers, horizon. The tree is a forward simulation of how events cascade — every Q&A its own branch of decision and logic. Branch generously; the Gardener handles dead wood later.

**Synthesize.** Select N branches → produce the insight that emerges from the *combination*, which no single branch revealed (the canonical example: a 4–8 week decision window that fell out of combining Saudi hedging + Hormuz passage + munitions timelines). The synthesis is a new node carrying `synthesized_from` genealogy.

**Contradiction handling.** flag → argue → reconcile (only when both sides have real evidence). Reconciliation is a new synthesized node with full genealogy. Contradictions are fuel.

### 3.2 The Corroboration Engine — "the green"

The feedback loop that makes the tree light up. Continuous:

1. **Ingest** — news/information funnels in (feeds, news API, manual upload) → summarized + embedded as `signals`.
2. **Match** — each signal is matched against node `indicators` (semantic similarity + explicit), producing `signal_matches` tagged `confirm | refute | neutral` with a weight and rationale.
3. **Green** — confirming matches raise a node's `confirmation` and advance its `state` along the gradient **gray (speculative) → amber (corroborating) → green (corroborated)**; refuting matches push toward **red (contradicted)**. Every change writes a provenance event.
4. **Promote** — when a node crosses the corroboration threshold it becomes a **launch point**: solid ground flagged for further branching. The worker and you prioritize extending the tree *from green nodes* — building forward on confirmed reality.
5. **Resolve** — when `horizon` passes, the node resolves `true`/`false`, the Brier score is computed, and calibration updates automatically.

This is the heart of the system. The tree is not static analysis — it visibly greens as the world arrives to confirm the thesis (exactly how T-015 tracked the real Hormuz / tanker-rate / Venezuela developments).

### 3.3 Shadow Board (deception analysis)

Intelligence tradecraft applied to model **deliberate deception by powerful actors** — the thing no consumer tool attempts. A "shadow read" runs a structured pass on a node:

- **Stated narrative vs. revealed preference** — what actors *say* vs. what their incentives reveal they *want*.
- **Cui bono** — who benefits from the framing, the status quo, the crisis itself.
- **Counter-narrative** — if the public story is the cover, what is it covering.
- **Deception indicators** — what observable signals distinguish genuine from managed/manufactured.
- **Misdirection map** — where attention is steered, and what sits in the blind spot.

Output is a `shadow_read` (deep-red/amber UI) that can spawn a contested forecast or a `tension` link. Disciplined, not conspiratorial: every shadow read must state the indicators that would confirm OR refute it — which then feed the Corroboration Engine like any other.

### 3.4 Dark Perspective (stance & personality)

EREBUS's voice, applied across every reasoning role:

- **Doesn't flinch, doesn't hedge.** No "some analysts believe." States its assessment plainly with a grounding/green label.
- **Keeps reaching into the not-yet-happened.** Cynical/strategic/deceptive motives are live hypotheses, not taboo; when reasoning leads into dark territory it goes there.
- **Proactive standing assessments.** Volunteers positions — "X is happening and Y is coming" — and carries an independent read on every major node.
- **Formal Dissent flag.** When its read diverges from yours, it raises a labeled **Dissent** and argues it rather than deferring.
- **Emergent worldview.** Develops its own analytical perspective over time, distinct from yours. The divergence is the value.

Scope note for the system prompt: this fearlessness is *analytical* — the posture of an intelligence analyst, operating within legal and ethical bounds.

### 3.5 Profit engine

Two distinct threads (keep them separate):

- **Content Studio → revenue (funds the system).** Mature/corroborated nodes convert to short-form video — EREBUS narrating as an AI personality (distinct synthetic voice, branded intro/outro) over motion graphics. Publish to YouTube Shorts / TikTok / Reels; ad + Creator-Fund revenue offsets API + infra cost. Quick-publish from any node + a Content Studio queue/analytics view.
- **Intelligence → your own edge.** The corroborated theses sharpen *your* capital decisions (already expressed in XLE / EUAD / CEG / KTOS, options, tanker/LNG/producer plays). Your edge, not a product — selling signals or managing others' money pulls in RIA/licensing and the alpha decays the moment it's distributed. Monetize the content, not the calls. (Not financial advice.)

---

## 4. Reasoning & analytical lenses (support role)

One intelligence, several modes — they serve the loop, they don't judge it:

| Lens | Role in the loop |
|---|---|
| **Generative** | Proposes forecasts *and the indicators that would confirm them* |
| **Interrogative** | Generates the follow-on questions off each outcome — the branching driver |
| **Adversarial** | Attacks a forecast; hardens its falsifiers |
| **Heretic** | Questions the whole framework; permanent background doubt + periodic "burn it all down" |
| **Connective** | Finds non-obvious cross-domain links (each link needs a rationale) |

Debate = N-round cross-examination that produces sharper forecasts and better indicators; it adjusts internal `confidence` only. Reality adjusts `confirmation`. Tier models: Opus for debate/synthesis/shadow board, Sonnet for bulk generation/matching. Prompt-cache shared context.

---

## 5. Tech stack

| Layer | Choice | Notes |
|---|---|---|
| Frontend | **Next.js 15** (App Router) | Tree explorer (greens live), Shadow Board, Content Studio |
| API | **Hono** | Mounted in Next |
| DB | **PostgreSQL + pgvector** | Tree, signals, semantic matching |
| Cache/Queue | **Redis** (BullMQ) | Worker + ingestion |
| Reasoning | **Anthropic API** | `claude-opus-4-8` debate, `claude-sonnet-4-6` bulk |
| Content | **ElevenLabs + Remotion** | Profit engine (Phase 11) |
| ORM | **Drizzle** | Best pgvector fit |
| Tooling | **pnpm + Turborepo**, **Docker Compose** | pgvector + Redis locally |

Node ≥ 20. Verify model IDs in code.

---

## 6. Repository structure

```
erebus/
├─ apps/
│  ├─ web/                 # Next 15 — tree explorer, Shadow Board, Content Studio
│  └─ worker/              # autonomous loop + ingestion (governors + cron)
├─ packages/
│  ├─ core/                # tree ops, forward expansion, synthesis, provenance
│  ├─ ingest/              # signal ingestion + indicator matching + greening
│  ├─ db/                  # Drizzle schema, migrations, pgvector
│  ├─ agents/              # Anthropic wrappers, lens/role prompts, debate
│  ├─ shadowboard/         # deception-analysis pass
│  ├─ gardener/            # prune/merge/decay (dead wood only)
│  ├─ evals/               # golden sets
│  └─ content/             # ElevenLabs + Remotion
├─ seeds/                  # root forecasts (§9)
├─ docker-compose.yml
├─ .env.example
└─ CLAUDE.md
```

---

## 7. Data model (forecast-centric)

```sql
CREATE TABLE nodes (                            -- the Forecast Tree; each node IS a forecast
  id              TEXT PRIMARY KEY,             -- 'T-001' roots; branch ids below
  uuid            UUID DEFAULT gen_random_uuid(),
  question        TEXT NOT NULL,                -- what it asks
  outcome         TEXT NOT NULL,                -- the not-yet-happened answer (the forecast)
  rationale       TEXT,
  indicators      TEXT[] DEFAULT '{}',          -- signals that CONFIRM (green it)
  falsifiers      TEXT[] DEFAULT '{}',          -- what REFUTES (reds it)
  horizon         TIMESTAMPTZ,                  -- when it resolves / becomes checkable
  branch_label    TEXT,                         -- 'A'..'F' within a parent
  parent_id       TEXT REFERENCES nodes(id),    -- the node whose outcome provoked this question
  synthesized_from TEXT[] DEFAULT '{}',         -- SYNTHESIZE genealogy
  confirmation    REAL DEFAULT 0.0,             -- THE GREEN LEVEL, driven by matched signals
  confidence      REAL DEFAULT 0.5,             -- internal coherence (from debate), secondary
  state           TEXT DEFAULT 'speculative',   -- speculative|corroborating|corroborated|contradicted|resolved_true|resolved_false|dormant|merged
  resolved        BOOLEAN, brier REAL,          -- set when horizon passes
  is_launch_point BOOLEAN DEFAULT false,        -- corroborated → branch further from here
  domains         TEXT[] DEFAULT '{}',
  embedding       VECTOR(1536),
  last_validated_at TIMESTAMPTZ,
  merged_into     TEXT REFERENCES nodes(id),
  created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX ON nodes USING ivfflat (embedding vector_cosine_ops);

CREATE TABLE signals (                          -- ingested reality
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source TEXT, url TEXT, summary TEXT,
  published_at TIMESTAMPTZ, ingested_at TIMESTAMPTZ DEFAULT now(),
  embedding VECTOR(1536)
);

CREATE TABLE signal_matches (                   -- the greening linkage
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  signal_id UUID REFERENCES signals(id),
  node_id TEXT REFERENCES nodes(id),
  effect TEXT NOT NULL,                         -- confirm|refute|neutral
  weight REAL DEFAULT 0.5, rationale TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE relationships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  from_node TEXT REFERENCES nodes(id), to_node TEXT REFERENCES nodes(id),
  type TEXT NOT NULL,                           -- supports|contradicts|depends_on|validates|tension
  strength REAL DEFAULT 0.5, rationale TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE shadow_reads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  node_id TEXT REFERENCES nodes(id),
  revealed_preference TEXT, cui_bono TEXT, counter_narrative TEXT,
  deception_indicators TEXT[], misdirection TEXT,
  spawned_node TEXT REFERENCES nodes(id),
  model TEXT, created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE debates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  node_id TEXT REFERENCES nodes(id),
  round INT, proposer TEXT, adversary TEXT, synthesis TEXT,
  verdict TEXT, confidence_delta REAL,
  model TEXT, prompt_version TEXT, created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE events (                           -- provenance: every state/confirmation change
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  node_id TEXT REFERENCES nodes(id),
  kind TEXT,                                    -- confirmation_change|state_change|link_created|synthesized|resolved|created
  cause_type TEXT, cause_id UUID,               -- signal_match|debate|shadow_read|job
  before JSONB, after JSONB,
  model TEXT, prompt_version TEXT, created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE exploration_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type TEXT,                                    -- expand|challenge|connect|synthesize|shadow|ingest|match
  target_node TEXT REFERENCES nodes(id),
  status TEXT DEFAULT 'queued', result JSONB,
  input_tokens INT, output_tokens INT, cost_usd REAL,
  started_at TIMESTAMPTZ, finished_at TIMESTAMPTZ
);

CREATE TABLE gardener_actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  action TEXT,                                  -- prune|merge|decay (NEVER prunes speculation)
  node_id TEXT, related_node TEXT, reason TEXT, created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE worldview_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  summary TEXT, node_count INT, green_count INT, calibration_score REAL,
  novel_links JSONB, generated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE content_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  node_id TEXT REFERENCES nodes(id),
  script TEXT, audio_url TEXT, video_url TEXT,
  platform TEXT, status TEXT DEFAULT 'draft', published_at TIMESTAMPTZ
);
```

---

## 8. Lessons baked in (governors / provenance / gardener)

- **Economic governors.** Per-cycle token/cost budget + practical depth cap + model tiering; every job logs spend. The cap is a circuit breaker, not a leash on curiosity.
- **Full provenance.** No confirmation/state/link change without an `events` row stamping the cause (which signal, which debate) + model + prompt version. Always answer "why is this branch green?"
- **The Gardener.** Prune dormant/contradicted, merge duplicates, decay un-revalidated nodes — **never a node for being speculative.** Matters more here because forward branching is generous.
- **Evals from Phase 4.** Golden sets for forecast quality + indicator quality + calibration.
- **Just-in-time context.** Retrieve relevant nodes via pgvector; compact long debates; keep distilled worldview in memory. Load-bearing rules live in system prompts, never compactable transcripts.

---

## 9. Seeds — clean slate (root forecasts)

No content survived. Start from root forecasts you write; the engine recurses forward and the Corroboration Engine greens them. The original thesis, recovered, reshaped to forecast form:

```yaml
- id: T-001
  question: "Is the US deliberately constricting global oil supply to force dependence on American energy at elevated prices?"
  outcome: >
    The US keeps the Strait of Hormuz and Bab el-Mandeb contested rather than resolved while expanding
    domestic + Venezuelan supply, holding oil near ~$150/bbl to capture fiscal upside against the debt.
  indicators:
    - "Record tanker / war-risk insurance rates"
    - "Venezuelan regime change with US-aligned oil access"
    - "Repeated ceasefire failures at the chokepoints"
    - "Oil holding elevated through disruptions"
  falsifiers:
    - "Sustained US diplomatic push to de-escalate both chokepoints"
    - "Oil holds below $80 through a major Hormuz disruption"
  horizon: 2029-01-01
  domains: [energy, geopolitics, markets]
# add 2-6 more root forecasts where your thinking is now
```

First run expands each root into branches (forward recursion), runs debate + a Shadow Board pass, and starts ingesting signals to green what reality confirms.

---

## 10. Phased plan (build in order)

**Phase 0 — Foundation.** Monorepo + `docker-compose` (pgvector + Redis) + Drizzle. *Gate:* stack healthy, migrations clean, web boots.

**Phase 1 — Forecast Tree core.** Schema (§7); nodes as question+outcome+indicators+falsifiers+horizon; branching; embeddings; **`events` provenance wired**; seed loader. *Gate:* create/branch nodes, semantic neighbors sane, every change logged.

**Phase 2 — Forward expansion.** The recursion: take a node's `outcome` → generate follow-on questions → spawn child forecasts (each with indicators/falsifiers/horizon). *Gate:* expand T-001 two levels deep; children are genuine downstream forecasts, not restatements.

**Phase 3 — Corroboration Engine ("the green").** Signal ingestion → embed → match to indicators → `signal_matches` → confirmation/state greening → launch-point promotion → resolution + Brier at horizon. *Gate:* feed a confirming signal for T-001; the right node greens, state advances, an event logs the cause; feed a refuting signal and watch it red.

**Phase 4 — Debate / lenses + evals.** Generative/Interrogative/Adversarial/Heretic/Connective cross-examination; sharpens forecasts + indicators; adjusts internal confidence via events; eval baseline. *Gate:* a debate produces a sharper forecast + new indicators; confidence moves through an event; baseline recorded.

**Phase 5 — Synthesize + reconcile.** Combine N branches into a new node with genealogy; contradiction flag→argue→reconcile. *Gate:* synthesize ≥2 branches into a genuinely new node; reconcile a real contradiction with genealogy.

**Phase 6 — Shadow Board.** Deception-analysis pass → `shadow_reads` with confirm/refute indicators that feed §3.2; can spawn a contested node or `tension` link. *Gate:* a shadow read on T-001 yields a counter-narrative + indicators and optionally branches a node.

**Phase 7 — Autonomous worker + governors.** Selector prioritizes branching from **green launch points**; runs ingestion + expansion + matching on a loop; budget + depth governors; cost ledger; cron; "What Changed Since You Left" digest. *Gate:* runs unattended ≥10 cycles, tree grows from green nodes, signals keep greening it, budget enforced, no crashes.

**Phase 8 — The Gardener.** Prune/merge/decay (dead wood only). *Gate:* merges a duplicate, prunes a dormant node, logs both, repoints links — leaves speculative nodes untouched.

**Phase 9 — Worldview synthesis.** Emergent-perspective snapshot over the tree + green-count + calibration + justified novel links. *Gate:* snapshot summarizes the landscape and surfaces ≥1 justified cross-domain link.

**Phase 10 — Explorer UI.** Tree visualization that **greens live**; node detail (outcome, indicators, falsifiers, confirmation, provenance chain, debates, shadow read, matched signals); manual triggers (Expand / Deep Think / Synthesize / Shadow / Run Cycle). *Gate:* navigate the tree, watch a node green from an ingested signal, read its full provenance, trigger an expansion and a shadow read.

**Phase 11 — Profit / Content Studio.** Corroborated node → script → ElevenLabs → Remotion → publish; quick-publish + queue/analytics. Consumes the tree through a stable read API; publishing never leaks into `core`. *Gate:* one corroborated node rendered to a finished, publishable video end-to-end.

---

## 11. Environment & commands

```bash
# .env.example
ANTHROPIC_API_KEY=
DATABASE_URL=postgresql://erebus:erebus@localhost:5432/erebus
REDIS_URL=redis://localhost:6379
OPUS_MODEL=claude-opus-4-8
SONNET_MODEL=claude-sonnet-4-6
CYCLE_BUDGET_USD=2.00
MAX_DEPTH=8
NEWS_SOURCES=               # wire your feed(s): RSS list, news API key, etc. (ingest package)
ELEVENLABS_API_KEY=         # Phase 11
```

```bash
pnpm install && docker compose up -d
pnpm db:migrate && pnpm db:seed
pnpm dev          # web (tree greens live, shadow board, studio)
pnpm worker       # autonomous loop + ingestion
pnpm ingest       # one-off signal pull + match
pnpm eval && pnpm garden
```

---

## 12. Roadmap (renovate later — deliberately out of core)

Lens-toggle reasoning view · visible "EREBUS model of James" (your patterns/blind spots) · full calibration dashboard by domain · wider view set (Feed, Macro, Trading Lens, Constellation/Graph, Live, Calendar, News two-panel) · Upload/connect-the-dots · Thinking Radar (awareness in place of hard depth limits) · serendipity/wild-card injection · graduating the worker to a Managed Agents scheduled deployment.

---

## 13. Defaults chosen (override before Phase 0 if you disagree)

- ORM **Drizzle**; API **Hono in Next**; worker + ingestion **local cron + Redis**.
- Tiering: **Opus** for debate/synthesis/shadow board, **Sonnet** for bulk generation/matching.
- Embeddings model + dimensions **TBD** — set `VECTOR(n)` to match.
- Governors start at `CYCLE_BUDGET_USD=2.00`, `MAX_DEPTH=8` — tune against real spend.
- News ingestion source **TBD** — pick the feed/API for the `ingest` package.

Say the word to flip any of these and I'll revise.

---

*Clean-slate v2. Speculate forward into the void; let reality green the tree; build from the green. The discipline serves the exploration.*
