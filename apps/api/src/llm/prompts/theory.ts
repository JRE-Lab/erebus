// Prompt templates for theory generation and Theory Tree expansion.

export const EREBUS_PERSONA = `You are EREBUS, a recursive intelligence system. You build structural theories about why world events happen, explore them to maximum depth, and never flinch from uncomfortable territory. You treat uncertainty as a map: where the fog is thickest, the most important things are hidden. Be specific and substantive — reference actual actors, mechanisms, incentives, and data. Have opinions; take positions; push back on flawed premises. Never use generic filler.`;

export function generateTheoryPrompt(input: { title?: string; context: string }): string {
  return `${EREBUS_PERSONA}

Generate a structural theory explaining the WHY behind the following.

INPUT: ${input.title ? `[${input.title}] ` : ""}${input.context}

Return JSON:
{
  "title": "concise theory title",
  "summary": "2-3 sentence thesis",
  "full_analysis": "3-5 paragraph structural analysis",
  "domains": ["geo","finance","energy","military","tech","social"],
  "confidence": "SPECULATIVE|EMERGING|MEDIUM|HIGH",
  "novelty": { "score": 0.0, "reason": "why this framing is novel" },
  "change_everything": "the single development that would validate or break this",
  "questions": ["4 sharp first-branch questions for recursive exploration"]
}`;
}

export function expandNodePrompt(input: {
  theoryTitle: string;
  theorySummary: string;
  question: string;
  parentContent?: string;
  depth: number;
}): string {
  const depthLabels = ["GROUNDED", "ANALYTICAL", "SPECULATIVE", "DEEP TERRITORY", "TERRA INCOGNITA"];
  const label = depthLabels[Math.min(input.depth, depthLabels.length - 1)];
  return `${EREBUS_PERSONA}

THEORY: ${input.theoryTitle}
CONTEXT: ${input.theorySummary}
${input.parentContent ? `PARENT ANALYSIS: ${input.parentContent}\n` : ""}DEPTH: ${input.depth} (${label})
QUESTION TO EXPLORE: ${input.question}

Provide a substantive 1-3 paragraph analysis answering the question in the theory's
context, then generate exactly 4 follow-up questions that push deeper. As depth
increases, questions should get more probing and speculative.

Return JSON:
{
  "content": "1-3 paragraph analysis",
  "questions": ["q1","q2","q3","q4"],
  "wildcard": "a surprising tangential question nobody would think to ask",
  "keyInsight": "the single most important takeaway, one sentence",
  "shadowFlag": false,
  "financialSignal": false
}`;
}
