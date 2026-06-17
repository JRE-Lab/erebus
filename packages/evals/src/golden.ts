// Golden set — sample forecast prompts for smoke-testing forecast generation
// quality. Each entry is a `context` passed to createForecast(); the optional
// `mustIncludeDomains` lets an eval assert the generated node touched the right
// territory. Spread across EREBUS's core domains (energy, geopolitics, markets,
// tech, defense) so the generator is exercised broadly.
export interface GoldenCase {
  id: string;
  context: string;
  mustIncludeDomains?: string[];
}

export const GOLDEN: GoldenCase[] = [
  {
    id: "G-001",
    context:
      "Is the US deliberately constricting global oil supply to force dependence on American energy at elevated prices, keeping the Strait of Hormuz and Bab el-Mandeb contested through 2029?",
    mustIncludeDomains: ["energy", "geopolitics"],
  },
  {
    id: "G-002",
    context:
      "Will sustained AI datacenter buildout drive a structural electricity supply crunch in the US, lifting power prices and reviving nuclear (e.g. CEG) over the next 3 years?",
    mustIncludeDomains: ["energy", "tech"],
  },
  {
    id: "G-003",
    context:
      "Does European rearmament (EUAD/KTOS-style defense spend) become a durable multi-year capital cycle rather than a one-off response to the Ukraine war?",
    mustIncludeDomains: ["defense", "markets"],
  },
  {
    id: "G-004",
    context:
      "Will the Federal Reserve be forced to tolerate above-target inflation to keep US debt servicing manageable, effectively running fiscal-dominance monetary policy by 2027?",
    mustIncludeDomains: ["markets"],
  },
  {
    id: "G-005",
    context:
      "Does Taiwan Strait tension escalate to a blockade or quarantine scenario that disrupts advanced-semiconductor supply within the next 4 years?",
    mustIncludeDomains: ["geopolitics", "tech"],
  },
];
