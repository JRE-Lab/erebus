// Content Studio step 1: node -> structured short-form script + storyboard.
// Offline-resilient: callJSON returns the fallback when the LLM is unavailable.
import { eq } from "drizzle-orm";
import { db, nodes, contentItems, recordEvent } from "@erebus/db";
import { callJSON, contentScriptPrompt, PROMPT_VERSION } from "@erebus/agents";

export interface Scene {
  narration: string;
  imagePrompt: string;
  image?: string | null; // public URL once generated
}

export interface ScriptShape {
  title: string;
  hook: string;
  script: string;
  caption: string;
  scenes: Scene[];
}

export interface GenerateScriptResult {
  contentId: string;
  script: ScriptShape;
  cost: number;
  offline: boolean;
}

export async function generateScript(nodeId: string): Promise<GenerateScriptResult> {
  const [node] = await db.select().from(nodes).where(eq(nodes.id, nodeId)).limit(1);
  if (!node) throw new Error(`generateScript: node not found: ${nodeId}`);

  const fallback: ScriptShape = {
    title: node.question.slice(0, 80),
    hook: node.question.slice(0, 120),
    script: `${node.question} EREBUS forecasts: ${node.outcome} Watch what reality confirms.`,
    caption: "#EREBUS #forecast #intelligence",
    scenes: [
      { narration: node.question, imagePrompt: "a dark intelligence war-room, world map glowing" },
      { narration: node.outcome, imagePrompt: "cinematic geopolitical tension, dramatic lighting" },
    ],
  };

  const { data, cost, offline } = await callJSON<ScriptShape>(
    contentScriptPrompt({ question: node.question, outcome: node.outcome, rationale: node.rationale ?? undefined }),
    fallback,
    { tier: "opus", agent: "content-script", targetNode: nodeId, maxTokens: 2000 }
  );

  const script: ScriptShape = {
    title: data.title || fallback.title,
    hook: data.hook || fallback.hook,
    script: data.script || fallback.script,
    caption: data.caption || fallback.caption,
    scenes: Array.isArray(data.scenes) && data.scenes.length ? data.scenes : fallback.scenes,
  };

  const [existing] = await db
    .select({ id: contentItems.id })
    .from(contentItems)
    .where(eq(contentItems.nodeId, nodeId))
    .limit(1);

  const values = {
    title: script.title,
    script: script.script,
    caption: script.caption,
    data: { hook: script.hook, scenes: script.scenes } as object,
    status: "scripted",
  };

  let contentId: string;
  if (existing) {
    const [row] = await db.update(contentItems).set(values).where(eq(contentItems.id, existing.id)).returning({ id: contentItems.id });
    contentId = row!.id;
  } else {
    const [row] = await db.insert(contentItems).values({ nodeId, ...values }).returning({ id: contentItems.id });
    contentId = row!.id;
  }

  await recordEvent({ nodeId, kind: "created", causeType: "job", after: { contentId, contentStatus: "scripted" }, promptVersion: PROMPT_VERSION });
  return { contentId, script, cost, offline };
}
