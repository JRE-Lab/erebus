// Provenance: every confirmation/state/link change writes an events row
// stamping its cause. Always answer "why is this branch green?"
import { db } from "./client.js";
import { events } from "./schema.js";

export interface EventInput {
  nodeId?: string | null;
  kind: string; // confirmation_change|state_change|link_created|synthesized|resolved|created|debate
  causeType?: string; // signal_match|debate|shadow_read|job
  causeId?: string;
  before?: unknown;
  after?: unknown;
  model?: string;
  promptVersion?: string;
}

export async function recordEvent(e: EventInput): Promise<void> {
  try {
    await db.insert(events).values({
      nodeId: e.nodeId ?? null,
      kind: e.kind,
      causeType: e.causeType ?? null,
      causeId: e.causeId ?? null,
      before: e.before ?? null,
      after: e.after ?? null,
      model: e.model ?? null,
      promptVersion: e.promptVersion ?? null,
    });
  } catch {
    /* provenance is best-effort, never blocks the mutation */
  }
}
