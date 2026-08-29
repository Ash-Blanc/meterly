/**
 * Seed Oracle's history with realistic spend data so estimates
 * have something to learn from on day one of the demo.
 */

import { BudgetTracker } from "../mcp-server/src/budget.js";

const tracker = new BudgetTracker(process.env.ORACLE_DB ?? "oracle.db");

const seed = [
  { taskDescription: "summarize a long research paper about transformers", model: "gpt-4o-mini", actualInputTokens: 8500, actualOutputTokens: 900, actualCostUsd: 0.0018 },
  { taskDescription: "summarize a long research paper about protein folding", model: "gpt-4o-mini", actualInputTokens: 9200, actualOutputTokens: 1100, actualCostUsd: 0.002 },
  { taskDescription: "research comparison of vector databases", model: "gpt-4o", actualInputTokens: 15000, actualOutputTokens: 3500, actualCostUsd: 0.0725 },
  { taskDescription: "research agent frameworks with 4 subagents", model: "gpt-4o", actualInputTokens: 48000, actualOutputTokens: 12000, actualCostUsd: 0.24 },
  { taskDescription: "research agent frameworks with 2 subagents", model: "gpt-4o", actualInputTokens: 26000, actualOutputTokens: 7000, actualCostUsd: 0.135 },
  { taskDescription: "write a short tweet thread about the project", model: "gpt-4o-mini", actualInputTokens: 1200, actualOutputTokens: 600, actualCostUsd: 0.0005 },
];

for (const s of seed) tracker.logSpend("seed", s);
console.log(`Seeded ${seed.length} history records.`);
console.log("Report:", JSON.stringify(tracker.getReport(), null, 2));
tracker.close();
