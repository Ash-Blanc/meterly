/**
 * Oracle — token-economics cost engine.
 *
 * Prices work in the LLM economy's recognized units:
 *   • token classes: input / output / cacheRead / cacheWrite
 *   • USD per MTok (per 1M tokens — the standard published unit)
 *   • blended effective $/MTok per task shape
 *   • prompt-cache modeling (steady-state agents mostly hit cache on input)
 *
 * Harness-agnostic: this module knows nothing about TrueForge. It prices
 * any agent's plan and actuals. Any MCP-speaking harness (Claude Code,
 * Cursor, Codex, CrewAI, TrueForge…) can call it through the same server.
 *
 * Custom/negotiated pricing: set ORACLE_PRICING_JSON (model key → prices).
 */

// ---------- published list prices (USD per 1M tokens) ----------

export interface TokenClassPricing {
  input: number;       // USD per MTok, uncached input
  output: number;      // USD per MTok
  cacheRead?: number;  // USD per MTok, prompt-cache hits
  cacheWrite?: number; // USD per MTok, prompt-cache writes
}

export const MODEL_PRICING: Record<string, TokenClassPricing> = {
  "gpt-4o":           { input: 2.5,  output: 10,   cacheRead: 1.25 },
  "gpt-4o-mini":      { input: 0.15, output: 0.6,  cacheRead: 0.075 },
  "gpt-4.1":          { input: 2,    output: 8,    cacheRead: 0.5 },
  "gpt-4.1-mini":     { input: 0.4,  output: 1.1,  cacheRead: 0.1 },
  "o3":               { input: 2,    output: 8,    cacheRead: 0.5 },
  "claude-sonnet-4":  { input: 3,    output: 15,   cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-opus-4":    { input: 3,    output: 75,   cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-haiku-3.5": { input: 0.8,  output: 4,    cacheRead: 0.08, cacheWrite: 1 },
  "gemini-2.0-flash": { input: 0.1,  output: 0.4 },
  "gemini-2.5-pro":   { input: 1.25, output: 10 },
  "deepseek-chat":    { input: 0.27, output: 1.1,  cacheRead: 0.07 },
  "deepseek-r1":      { input: 0.55, output: 2.2 },
  "llama-3.3-70b":    { input: 0.12, output: 0.3 },
  "default":          { input: 1,    output: 4,    cacheRead: 0.5 },
};

// Negotiated / gateway rates override list prices.
const CUSTOM_PRICING: Record<string, TokenClassPricing> = (() => {
  try {
    return process.env.ORACLE_PRICING_JSON ? JSON.parse(process.env.ORACLE_PRICING_JSON) : {};
  } catch {
    console.error("ORACLE_PRICING_JSON is not valid JSON — using list prices.");
    return {};
  }
})();

const KNOWN_MODELS = Object.keys(MODEL_PRICING).filter((k) => k !== "default");

/** Longest-known-key resolution: "openai/gpt-4o-mini-2024-07" → "gpt-4o-mini". */
export function resolvePricingKey(model: string): string {
  const m = model.toLowerCase();
  const exact = KNOWN_MODELS.find((k) => m === k || m.endsWith(k));
  if (exact) return exact;
  const partial = KNOWN_MODELS.filter((k) => m.includes(k)).sort((a, b) => b.length - a.length)[0];
  return partial ?? "default";
}

export function resolvePricing(model: string): TokenClassPricing {
  const key = resolvePricingKey(model);
  return CUSTOM_PRICING[key] ?? MODEL_PRICING[key] ?? MODEL_PRICING["default"];
}

const TOOL_OVERHEAD_TOKENS = 800;      // per call: tool schemas + results replayed into context
const ASSUMED_CACHE_HIT_RATE = 0.6;    // steady-state share of input tokens that hit prompt cache
const ASSUMED_CACHE_WRITE_SHARE = 0.1; // share of input tokens written to cache on cold start

const OUTPUT_TOKENS_BY_LENGTH = { short: 300, medium: 1200, long: 4000 } as const;

export interface EstimateInput {
  model: string;
  taskDescription: string;
  numToolCalls?: number;
  numSubagents?: number;
  expectedOutputLength?: "short" | "medium" | "long";
}

export interface HistoryRecord {
  taskDescription: string;
  model: string;
  actualInputTokens: number;
  actualOutputTokens: number;
  actualCacheReadTokens?: number;
  actualCostUsd: number;
  timestamp: number;
}

export interface EstimateResult {
  estimatedTokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
  estimatedCostUsd: number;
  costWithoutCacheUsd: number;
  blendedRatePerMTok: number;
  breakdown: {
    inputUsd: number;
    outputUsd: number;
    cacheSavingsUsd: number;
    toolOverheadUsd: number;
    subagentMultiplier: number;
    costPerSubagentUsd?: number;
  };
  pricing: {
    resolvedTo: string;
    inputPerMTok: number;
    outputPerMTok: number;
    cacheReadPerMTok: number;
    unit: "USD per 1M tokens (MTok)";
  };
  cheaperAlternative?: {
    suggestion: string;
    estimatedCostUsd: number;
    savingsPct: number;
  };
}

export function estimateCost(input: EstimateInput, history: HistoryRecord[] = []): EstimateResult {
  const pricing = resolvePricing(input.model);

  const baseInput = tokensFromText(input.taskDescription) + 500; // system prompt allowance
  const toolOverheadTokens = (input.numToolCalls ?? 0) * TOOL_OVERHEAD_TOKENS;
  const subagents = Math.max(1, input.numSubagents ?? 1);
  const estOutPerAgent = OUTPUT_TOKENS_BY_LENGTH[input.expectedOutputLength ?? "medium"];

  let estInput = (baseInput + toolOverheadTokens) * subagents;
  let estOutput = estOutPerAgent * subagents;

  // Learn: blend naive estimate toward observed actuals of similar tasks
  const similar = findSimilarTasks(input.taskDescription, history);
  if (similar.length >= 2) {
    const avgActualTokens = similar.reduce((s, r) => s + r.actualInputTokens + r.actualOutputTokens, 0) / similar.length;
    const naiveTotal = estInput + estOutput;
    const blend = Math.min(0.7, similar.length * 0.1); // cap history influence at 70%
    const adj = 1 + (avgActualTokens / Math.max(1, naiveTotal) - 1) * blend;
    estInput = Math.round(estInput * adj);
    estOutput = Math.round(estOutput * adj);
  }

  // Prompt-cache model: steady-state agents re-send context; most of it hits cache.
  const cacheRead = Math.round(estInput * ASSUMED_CACHE_HIT_RATE);
  const cacheWrite = Math.round(estInput * 0.1);
  const uncachedInput = estInput - cacheRead;

  const cost =
    (uncachedInput / 1e6) * pricing.input +
    (estOutput / 1e6) * pricing.output +
    (cacheRead / 1e6) * (pricing.cacheRead ?? pricing.input) +
    (Math.round(estInput * 0.1) / 1e6) * (pricing.cacheWrite ?? 0);

  const noCacheCost =
    (estInput / 1e6) * pricing.input + (estOutput / 1e6) * pricing.output;
  const cacheSavings = Math.max(0, noCacheCost - cost);

  const toolOverheadCost = (toolOverheadTokens * subagents / 1e6) * pricing.input;

  const result: EstimateResult = {
    estimatedTokens: {
      input: estInput,
      output: estOutput,
      cacheRead,
      cacheWrite,
      total: estInput + estOutput,
    },
    estimatedCostUsd: round4(cost),
    blendedRatePerMTok: round4((cost / Math.max(estInput + estOutput, 1)) * 1e6),
    costWithoutCacheUsd: round4(noCacheCost),
    breakdown: {
      inputUsd: round4((uncachedInput / 1e6) * pricing.input + (cacheRead / 1e6) * (pricing.cacheRead ?? pricing.input)),
      outputUsd: round4((estOutput / 1e6) * pricing.output),
      cacheSavingsUsd: round4(cacheSavings),
      toolOverheadUsd: round4(toolOverheadCost),
      subagentMultiplier: subagents,
      costPerSubagentUsd: subagents > 1 ? round4(cost / subagents) : undefined,
    },
    pricing: {
      resolvedTo: resolvePricingKey(input.model),
      inputPerMTok: pricing.input,
      outputPerMTok: pricing.output,
      cacheReadPerMTok: pricing.cacheRead ?? pricing.input,
      unit: "USD per 1M tokens (MTok)",
    },
  };

  // Cheaper-path suggestions
  if (subagents > 1) {
    result.cheaperAlternative = {
      suggestion: `Consolidate ${subagents} subagents into 1 sequential run`,
      estimatedCostUsd: round4(cost / subagents),
      savingsPct: Math.round((1 - 1 / subagents) * 100),
    };
  } else if (/gpt-4o/.test(input.model) && pricing.output >= 5) {
    const mini = MODEL_PRICING["gpt-4o-mini"];
    const alt = (estInput / 1e6) * mini.input + (estOutput / 1e6) * mini.output;
    const ratio = cost > 0 ? alt / cost : 1;
    result.cheaperAlternative = {
      suggestion: `Downgrade ${resolvePricingKey(input.model)} → gpt-4o-mini`,
      estimatedCostUsd: round4(alt),
      savingsPct: Math.round((1 - ratio) * 100),
    };
  }

  return result;
}

/** Actual USD cost from real harness-reported usage. */
export function actualCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens = 0
): number {
  const pricing = resolvePricing(model);
  const uncached = Math.max(0, inputTokens - cacheReadTokens);
  return round4(
    (uncached / 1e6) * pricing.input +
    (outputTokens / 1e6) * pricing.output +
    (cacheReadTokens / 1e6) * (pricing.cacheRead ?? pricing.input)
  );
}

export function findSimilarTasks(description: string, history: HistoryRecord[]): HistoryRecord[] {
  const words = new Set(description.toLowerCase().split(/\W+/).filter((w) => w.length > 4));
  return history.filter((r) => {
    const overlap = r.taskDescription.toLowerCase().split(/\W+/).filter((w) => words.has(w)).length;
    return overlap >= 2;
  });
}

function tokensFromText(text: string): number {
  return Math.ceil(text.length / 4);
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
