/**
 * Oracle — cost estimation engine.
 * Estimates USD cost of an LLM call from model pricing + estimated token usage.
 * Learns from logged history to refine future estimates.
 */

export interface ModelPricing {
  inputPer1M: number;   // USD per 1M input tokens
  outputPer1M: number;  // USD per 1M output tokens
}

// Pricing table — extend as needed. USD per 1M tokens.
export const MODEL_PRICING: Record<string, ModelPricing> = {
  "gpt-4o": { inputPer1M: 2.5, outputPer1M: 10 },
  "gpt-4o-mini": { inputPer1M: 0.15, outputPer1M: 0.6 },
  "claude-sonnet-4": { inputPer1M: 3, outputPer1M: 15 },
  "claude-haiku-3.5": { inputPer1M: 0.8, outputPer1M: 4 },
  "gemini-2.0-flash": { inputPer1M: 0.1, outputPer1M: 0.4 },
  "default": { inputPer1M: 1, outputPer1M: 4 },
};

// Rough multiplier for tool-call overhead (tool schemas + results in context)
const TOOL_OVERHEAD_TOKENS = 800;

export interface EstimateInput {
  model: string;
  taskDescription: string;
  numToolCalls?: number;
  numSubagents?: number;
  expectedOutputLength?: "short" | "medium" | "long";
}

export interface EstimateResult {
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  estimatedCostUsd: number;
  breakdown: {
    base: number;
    toolOverhead: number;
    subagentMultiplier: number;
  };
  cheaperAlternative?: {
    suggestion: string;
    estimatedCostUsd: number;
    savingsPct: number;
  };
}

/** Rough heuristic: ~4 chars per token for English prose. */
function tokensFromText(text: string): number {
  return Math.ceil(text.length / 4);
}

const OUTPUT_TOKENS_BY_LENGTH = { short: 300, medium: 1200, long: 4000 };

export function estimateCost(input: EstimateInput, history: HistoryRecord[] = []): EstimateResult {
  const pricing = MODEL_PRICING[input.model] ?? MODEL_PRICING["default"];
  const baseInput = tokensFromText(input.taskDescription) + 500; // system prompt overhead
  const toolOverhead = (input.numToolCalls ?? 0) * TOOL_OVERHEAD_TOKENS;
  const subagentCount = input.numSubagents ?? 1;

  let estimatedInputTokens = (baseInput + toolOverhead) * subagentCount;
  let estimatedOutputTokens = (OUTPUT_TOKENS_BY_LENGTH[input.expectedOutputLength ?? "medium"]) * subagentCount;

  // Learn from history: if similar past tasks ran cheaper/more expensive, nudge the estimate
  const similar = findSimilarTasks(input.taskDescription, history);
  if (similar.length >= 2) {
    const avgActual = similar.reduce((s, r) => s + r.actualCostUsd, 0) / similar.length;
    const naive = (estimatedInputTokens / 1e6) * pricing.inputPer1M + (estimatedOutputTokens / 1e6) * pricing.outputPer1M;
    // Blend naive estimate with observed average (history wins as it accumulates)
    const blend = Math.min(0.7, similar.length * 0.1);
    const blended = naive * (1 - blend) + avgActual * blend;
    const ratio = blended / Math.max(naive, 1e-9);
    estimatedInputTokens = Math.round(estimatedInputTokens * Math.sqrt(ratio));
    estimatedOutputTokens = Math.round(estimatedOutputTokens * Math.sqrt(ratio));
  }

  const cost =
    (estimatedInputTokens / 1e6) * pricing.inputPer1M +
    (estimatedOutputTokens / 1e6) * pricing.outputPer1M;

  const result: EstimateResult = {
    estimatedInputTokens,
    estimatedOutputTokens,
    estimatedCostUsd: round4(cost),
    breakdown: {
      base: round4((baseInput / 1e6) * pricing.inputPer1M),
      toolOverhead: round4((toolOverhead / 1e6) * pricing.inputPer1M),
      subagentMultiplier: subagentCount,
    },
  };

  // Cheaper alternative: fewer subagents or cheaper model
  if (subagentCount > 1) {
    const altCost = cost / subagentCount;
    result.cheaperAlternative = {
      suggestion: `Consolidate ${subagentCount} subagents into 1 sequential run`,
      estimatedCostUsd: round4(altCost),
      savingsPct: Math.round((1 - 1 / subagentCount) * 100),
    };
  } else if (input.model === "gpt-4o" && MODEL_PRICING["gpt-4o-mini"]) {
    const miniPricing = MODEL_PRICING["gpt-4o-mini"];
    const altCost =
      (estimatedInputTokens / 1e6) * miniPricing.inputPer1M +
      (estimatedOutputTokens / 1e6) * miniPricing.outputPer1M;
    result.cheaperAlternative = {
      suggestion: "Use gpt-4o-mini instead of gpt-4o",
      estimatedCostUsd: round4(altCost),
      savingsPct: Math.round((1 - altCost / cost) * 100),
    };
  }

  return result;
}

export interface HistoryRecord {
  taskHash: string;
  taskDescription: string;
  model: string;
  actualInputTokens: number;
  actualOutputTokens: number;
  actualCostUsd: number;
  timestamp: number;
}

function findSimilarTasks(description: string, history: HistoryRecord[]): HistoryRecord[] {
  const words = new Set(description.toLowerCase().split(/\W+/).filter((w) => w.length > 4));
  return history.filter((r) => {
    const rWords = r.taskDescription.toLowerCase().split(/\W+/);
    const overlap = rWords.filter((w) => words.has(w)).length;
    return overlap >= 2;
  });
}

export function actualCost(model: string, inputTokens: number, outputTokens: number): number {
  const pricing = MODEL_PRICING[model] ?? MODEL_PRICING["default"];
  return round4((inputTokens / 1e6) * pricing.inputPer1M + (outputTokens / 1e6) * pricing.outputPer1M);
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
