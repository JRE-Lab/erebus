// ============================================================================
// Content Studio — Phase 11 profit engine. Step 1: node -> short-form script.
// A mature/corroborated node converts to a punchy 45-60s EREBUS narration.
// Fully offline-resilient: callJSON returns the fallback when llmLive() is false.
// ============================================================================
import { eq } from "drizzle-orm";
import { db, nodes, contentItems, recordEvent } from "@erebus/db";
import { callJSON, contentScriptPrompt, PROMPT_VERSION } from "@erebus/agents";

// The structured script we ask the model for, serialized into contentItems.script.
export interface ScriptShape {
  title: string;
  script: string; // the spoken narration
  hook: string;
  caption: string; // social caption with hashtags
}

export interface GenerateScriptResult {
  contentId: string;
  script: ScriptShape;
  cost: number;
  offline: boolean;
}

// Load a node, generate its script via Opus, and upsert a draft content_items row.
// The narration + title + caption are stored as a JSON blob in `script` (text col).
export async function generateScript(nodeId: string): Promise<GenerateScriptResult> {
  const [node] = await db.select().from(nodes).where(eq(nodes.id, nodeId)).limit(1);
  if (!node) throw new Error(`generateScript: node not found: ${nodeId}`);

  const fallback: ScriptShape = {
    title: node.question.slice(0, 80),
    script: `[offline] ${node.question} EREBUS forecasts: ${node.outcome} Watch what reality confirms.`,
    hook: node.question.slice(0, 120),
    caption: "#EREBUS #forecast #intelligence",
  };

  const { data, cost, offline } = await callJSON<ScriptShape>(
    contentScriptPrompt({
      question: node.question,
      outcome: node.outcome,
      rationale: node.rationale ?? undefined,
    }),
    fallback,
    { tier: "opus", agent: "content-script", targetNode: nodeId, maxTokens: 1500 }
  );

  // Normalize: never trust the model to fill every field.
  const script: ScriptShape = {
    title: data.title || fallback.title,
    script: data.script || fallback.script,
    hook: data.hook || fallback.hook,
    caption: data.caption || fallback.caption,
  };

  const serialized = JSON.stringify(script);

  // Upsert: reuse an existing draft for this node if present, else insert.
  const [existing] = await db
    .select({ id: contentItems.id })
    .from(contentItems)
    .where(eq(contentItems.nodeId, nodeId))
    .limit(1);

  let contentId: string;
  if (existing) {
    const [row] = await db
      .update(contentItems)
      .set({ script: serialized, status: "draft" })
      .where(eq(contentItems.id, existing.id))
      .returning({ id: contentItems.id });
    contentId = row!.id;
  } else {
    const [row] = await db
      .insert(contentItems)
      .values({ nodeId, script: serialized, status: "draft" })
      .returning({ id: contentItems.id });
    contentId = row!.id;
  }

  await recordEvent({
    nodeId,
    kind: "created",
    causeType: "job",
    after: { contentId, contentStatus: "draft" },
    promptVersion: PROMPT_VERSION,
  });

  return { contentId, script, cost, offline };
}
