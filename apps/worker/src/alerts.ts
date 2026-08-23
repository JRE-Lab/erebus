// Alert derivation — turns provenance events into operator alerts. Runs on a
// cheap timer (no LLM, DB-only — so it runs even while paused / off-hours):
// scan events since the watermark, keep the ones a human should know about NOW,
// write alert rows (Explorer bell), and push to Telegram when
// TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID are configured (optional).
//
// Watermark correctness (review findings): the cursor advances to the createdAt
// of the LAST PROCESSED event — never to the worker's clock — so a >LIMIT
// backlog resumes next tick instead of being dropped, and DB/worker clock skew
// can neither lose nor double-process events. First run initializes the
// watermark to the newest existing event WITHOUT alerting (no historical flood).
import { and, gt, lt, asc, desc, sql, inArray, isNotNull } from "drizzle-orm";
import { db, events, nodes, alerts, getSetting, setSetting } from "@erebus/db";

const SCAN_LIMIT = 500;
const DEDUP_HOURS = 24; // same (node, kind) alerts at most once per day
const RETAIN_DAYS = 30; // prune seen alerts older than this

interface EvtShape {
  state?: string;
  resolved?: boolean;
  stability?: number;
  genesis?: boolean;
  dark?: boolean;
}

const STATE_ALERTS: Record<string, { kind: string; label: string }> = {
  corroborated: { kind: "greened", label: "corroborated — reality is confirming it" },
  tipping: { kind: "tipping", label: "TIPPING — confirming but on a fragile equilibrium" },
  contradicted: { kind: "contradicted", label: "contradicted — reality is refuting it" },
};

interface Draft {
  kind: string;
  nodeId: string | null;
  title: string;
}

export async function runAlerts(): Promise<{ scanned: number; alerts: number }> {
  // Sentinel fallback distinguishes "no watermark yet" from a real cursor.
  const wm = await getSetting<{ t: string | null }>("alerts_watermark", { t: null });
  if (!wm.t) {
    // First run: start from the newest existing event — alert only on the future.
    const [latest] = await db
      .select({ t: events.createdAt })
      .from(events)
      .orderBy(desc(events.createdAt))
      .limit(1);
    await setSetting("alerts_watermark", { t: (latest?.t ?? new Date()).toISOString() });
    return { scanned: 0, alerts: 0 };
  }

  const rows = await db
    .select()
    .from(events)
    .where(gt(events.createdAt, new Date(wm.t)))
    .orderBy(asc(events.createdAt))
    .limit(SCAN_LIMIT);
  if (!rows.length) return { scanned: 0, alerts: 0 };

  // Pass 1: classify (pure, no awaits).
  const drafts: Draft[] = [];
  for (const e of rows) {
    const after = (e.after ?? {}) as EvtShape;
    const before = (e.before ?? {}) as EvtShape;
    if (e.kind === "state_change" && after.state && after.state !== before.state && STATE_ALERTS[after.state]) {
      const a = STATE_ALERTS[after.state]!;
      drafts.push({ kind: a.kind, nodeId: e.nodeId, title: `${e.nodeId} ${a.label}` });
    } else if (e.kind === "resolved") {
      drafts.push({
        kind: "resolved",
        nodeId: e.nodeId,
        title: `${e.nodeId} resolved: it ${after.resolved ? "HAPPENED" : "did not happen"}`,
      });
    } else if (e.kind === "game_read" && typeof after.stability === "number" && after.stability < 0.35) {
      drafts.push({
        kind: "fragile",
        nodeId: e.nodeId,
        title: `${e.nodeId} sits on a FRAGILE equilibrium (stability ${after.stability.toFixed(2)})`,
      });
    } else if (e.kind === "created" && after.genesis) {
      drafts.push({
        kind: after.dark ? "dark_genesis" : "genesis",
        nodeId: e.nodeId,
        title: after.dark ? `⚡ dark theory born: ${e.nodeId}` : `✦ new theory born: ${e.nodeId}`,
      });
    } else if (e.kind === "resolution_disputed") {
      drafts.push({
        kind: "disputed",
        nodeId: e.nodeId,
        title: `${e.nodeId} resolution DISPUTED — sources contradict the stored outcome`,
      });
    }
  }

  let made = 0;
  const lines: string[] = [];
  if (drafts.length) {
    // Pass 2: batch-load questions + recent alerts for dedup (2 queries, not N).
    const ids = Array.from(new Set(drafts.map((d) => d.nodeId).filter(Boolean))) as string[];
    const qRows = ids.length
      ? await db.select({ id: nodes.id, q: nodes.question }).from(nodes).where(inArray(nodes.id, ids))
      : [];
    const questions = new Map(qRows.map((r) => [r.id, r.q]));

    const cutoff = new Date(Date.now() - DEDUP_HOURS * 3_600_000);
    const recent = ids.length
      ? await db
          .select({ nodeId: alerts.nodeId, kind: alerts.kind })
          .from(alerts)
          .where(and(inArray(alerts.nodeId, ids), gt(alerts.createdAt, cutoff)))
      : [];
    const seenKeys = new Set(recent.map((r) => `${r.nodeId}|${r.kind}`));

    const values: Array<{ kind: string; nodeId: string | null; title: string; detail: string | null }> = [];
    for (const d of drafts) {
      const key = `${d.nodeId}|${d.kind}`;
      if (d.nodeId && seenKeys.has(key)) continue; // same node+kind at most 1/day
      seenKeys.add(key);
      const detail = d.nodeId ? questions.get(d.nodeId) ?? null : null;
      values.push({ kind: d.kind, nodeId: d.nodeId, title: d.title, detail });
      lines.push(`• ${d.title}${detail ? `\n  ${detail.slice(0, 140)}` : ""}`);
    }
    if (values.length) {
      await db.insert(alerts).values(values);
      made = values.length;
    }
  }

  // Cursor: the last PROCESSED event's DB timestamp — backlog-safe, skew-safe.
  // +1ms because toISOString() truncates Postgres microseconds: without it the
  // strict `>` re-reads the tail event every tick (duplicate Telegram pushes
  // once the 24h dedup lapses). Events sharing the same millisecond arrive in
  // the same 500-row page in practice, so the skip risk is negligible.
  const last = rows[rows.length - 1]!;
  await setSetting("alerts_watermark", { t: new Date(last.createdAt.getTime() + 1).toISOString() });

  // Housekeeping: prune old seen alerts so the unseen count stays cheap.
  try {
    await db
      .delete(alerts)
      .where(and(isNotNull(alerts.seenAt), lt(alerts.createdAt, sql`now() - interval '${sql.raw(String(RETAIN_DAYS))} days'`)));
  } catch {
    /* retention is best-effort */
  }

  if (lines.length) await telegram(lines.join("\n"));
  return { scanned: rows.length, alerts: made };
}

// Optional push — silently skipped without credentials.
async function telegram(text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text: `EREBUS\n${text}`.slice(0, 4000) }),
    });
  } catch {
    /* alerting must never break the worker */
  }
}
