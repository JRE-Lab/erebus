// Source-verified resolution sweep. For every DUE theory (horizon passed,
// unresolved) gather its evidence — matched signals with their sources, padded
// with nearby unmatched signals — and have a strict judge decide from that
// evidence alone whether the outcome ACTUALLY occurred. Auto-adjudicates only
// confident verdicts (source "verifier"); everything else stays for the
// operator. Also AUDITS recently-resolved theories: a confident verdict that
// contradicts a stored resolution raises a "resolution_disputed" event (never
// overwrites — adjudicate is idempotent by design).
import { and, asc, desc, eq, isNull, lte } from "drizzle-orm";
import { db, nodes, signals, signalMatches, nearest, recordEvent } from "@erebus/db";
import { callJSON, resolutionVerifyPrompt } from "@erebus/agents";
import { adjudicate } from "./scoring.js";
import type { NodeRow } from "./types.js";

const CONF_THRESHOLD = 0.7;

interface VerdictShape {
  verdict: "happened" | "did_not_happen" | "unclear";
  confidence: number;
  rationale: string;
  citedSources: string[];
}

const FALLBACK: VerdictShape = { verdict: "unclear", confidence: 0, rationale: "", citedSources: [] };

function clamp01(n: unknown): number {
  const v = typeof n === "number" ? n : Number(n);
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0;
}

// Evidence lines: the node's matched signals first (source + url + judged
// effect), padded with semantically-near unmatched signals when thin.
async function evidenceFor(node: NodeRow): Promise<string[]> {
  const matched = await db
    .select({
      title: signals.title,
      summary: signals.summary,
      source: signals.source,
      url: signals.url,
      effect: signalMatches.effect,
    })
    .from(signalMatches)
    .leftJoin(signals, eq(signalMatches.signalId, signals.id))
    .where(eq(signalMatches.nodeId, node.id))
    .orderBy(desc(signalMatches.createdAt))
    .limit(12);

  const seen = new Set<string>();
  const ev: string[] = [];
  for (const m of matched) {
    if (!m.title || seen.has(m.title)) continue;
    seen.add(m.title);
    ev.push(`[${m.source ?? "?"}] ${m.title} — ${(m.summary ?? "").slice(0, 160)} (judged: ${m.effect}) ${m.url ?? ""}`);
  }

  if (ev.length < 3 && node.embedding) {
    try {
      const near = await nearest("signals", node.embedding, 8);
      for (const c of near) {
        const [s] = await db.select().from(signals).where(eq(signals.id, String(c.id))).limit(1);
        if (s?.title && !seen.has(s.title)) {
          seen.add(s.title);
          ev.push(`[${s.source ?? "?"}] ${s.title} — ${(s.summary ?? "").slice(0, 160)} (nearby, unjudged) ${s.url ?? ""}`);
        }
      }
    } catch {
      /* nearest is best-effort padding */
    }
  }
  return ev.slice(0, 14);
}

async function judge(
  node: NodeRow,
  ev: string[]
): Promise<{ verdict: VerdictShape; cost: number; offline: boolean }> {
  const { data, cost, offline } = await callJSON<VerdictShape>(
    resolutionVerifyPrompt(
      { question: node.question, outcome: node.outcome, horizon: node.horizon ? node.horizon.toISOString() : null },
      ev
    ),
    FALLBACK,
    { tier: "sonnet", agent: "verify-resolution", targetNode: node.id, maxTokens: 700 }
  );
  return { verdict: data, cost, offline };
}

export interface VerifyResult {
  due: number; // horizon-passed unresolved theories found
  checked: number; // judged this run
  resolved: number; // confidently adjudicated
  unclear: number; // left for the operator
  audited: number; // already-resolved theories re-verified
  disputed: number; // stored resolutions the sources contradict
  cost: number;
}

export async function verifyResolutions(
  opts: { limit?: number; auditResolved?: boolean } = {}
): Promise<VerifyResult> {
  const limit = Math.max(1, Math.min(40, opts.limit ?? 20));
  const res: VerifyResult = { due: 0, checked: 0, resolved: 0, unclear: 0, audited: 0, disputed: 0, cost: 0 };

  // 1) Due, unresolved -> judge -> confidently adjudicate.
  const due = await db
    .select()
    .from(nodes)
    .where(and(isNull(nodes.resolved), lte(nodes.horizon, new Date())))
    .orderBy(asc(nodes.horizon))
    .limit(limit);
  res.due = due.length;

  for (const node of due) {
    const ev = await evidenceFor(node);
    if (!ev.length) {
      res.unclear++;
      continue; // no sources -> nothing to verify against
    }
    const { verdict, cost, offline } = await judge(node, ev);
    res.cost += cost;
    if (offline) {
      res.unclear++;
      continue; // never resolve on a fallback
    }
    res.checked++;
    const conf = clamp01(verdict.confidence);
    if (verdict.verdict === "unclear" || conf < CONF_THRESHOLD) {
      res.unclear++;
      continue;
    }
    const happened = verdict.verdict === "happened";
    await recordEvent({
      nodeId: node.id,
      kind: "resolution_verified",
      causeType: "job",
      after: {
        happened,
        confidence: conf,
        rationale: (verdict.rationale ?? "").slice(0, 400),
        sources: (verdict.citedSources ?? []).slice(0, 6),
      },
    });
    if (await adjudicate(node.id, happened, "verifier")) res.resolved++;
  }

  // 2) Audit recently-resolved theories: flag (never overwrite) contradictions.
  if (opts.auditResolved !== false) {
    const done = await db
      .select()
      .from(nodes)
      .where(eq(nodes.resolved, true))
      .orderBy(desc(nodes.updatedAt))
      .limit(10);
    for (const node of done) {
      const ev = await evidenceFor(node);
      if (!ev.length) continue;
      const { verdict, cost, offline } = await judge(node, ev);
      res.cost += cost;
      if (offline) continue;
      res.audited++;
      const conf = clamp01(verdict.confidence);
      if (verdict.verdict === "unclear" || conf < CONF_THRESHOLD) continue;
      const happened = verdict.verdict === "happened";
      if (happened !== Boolean(node.resolvedOutcome)) {
        res.disputed++;
        await recordEvent({
          nodeId: node.id,
          kind: "resolution_disputed",
          causeType: "job",
          before: { resolvedOutcome: node.resolvedOutcome, source: node.resolvedSource },
          after: {
            happened,
            confidence: conf,
            rationale: (verdict.rationale ?? "").slice(0, 400),
            sources: (verdict.citedSources ?? []).slice(0, 6),
          },
        });
      }
    }
  }

  return res;
}
