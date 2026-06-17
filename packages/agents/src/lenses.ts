// The five reasoning lenses (§4). One intelligence, several modes — they serve
// the loop, they do not judge it. Reality adjusts confirmation; debate adjusts
// only internal confidence.
export const LENSES = {
  generative: { title: "Generative", role: "Proposes forecasts and the indicators that would confirm them." },
  interrogative: { title: "Interrogative", role: "Generates the follow-on questions off each outcome — the branching driver." },
  adversarial: { title: "Adversarial", role: "Attacks a forecast; hardens its falsifiers." },
  heretic: { title: "Heretic", role: "Questions the whole framework; permanent background doubt." },
  connective: { title: "Connective", role: "Finds non-obvious cross-domain links (each link needs a rationale)." },
} as const;

export type LensKey = keyof typeof LENSES;
