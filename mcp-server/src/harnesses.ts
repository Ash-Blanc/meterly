import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { DatabaseSync } from "node:sqlite";

export interface UsageRecord {
  harness: string;
  sessionRef: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  apiCalls: number;
  actualCostUsd: number | null;
  firstSeen?: number;
  lastSeen?: number;
}

export interface HarnessInfo {
  id: string;
  label: string;
  detected: boolean;
}

export interface HarnessAdapter {
  id: string;
  label: string;
  detect(): boolean;
  ingest(): UsageRecord[];
}

const HOME = homedir();

interface HermesUsageRow {
  session_id: string;
  model: string;
  api_call_count: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  actual_cost_usd: number;
  first_seen: number | null;
  last_seen: number | null;
}

const hermes: HarnessAdapter = {
  id: "hermes",
  label: "Hermes",
  detect: () => existsSync(join(HOME, ".hermes", "state.db")),
  ingest(): UsageRecord[] {
    try {
      const db = new DatabaseSync(join(HOME, ".hermes", "state.db"), { readOnly: true });
      const rows = db
        .prepare("SELECT session_id, model, api_call_count, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, estimated_cost_usd, actual_cost_usd, first_seen, last_seen FROM session_model_usage")
        .all() as unknown as HermesUsageRow[];
      db.close();
      return rows.map((r) => ({
        harness: "hermes",
        sessionRef: String(r.session_id),
        model: r.model,
        inputTokens: Number(r.input_tokens) || 0,
        outputTokens: Number(r.output_tokens ?? 0),
        cacheReadTokens: Number(r.cache_read_tokens ?? 0),
        cacheWriteTokens: Number(r.cache_write_tokens ?? 0),
        apiCalls: Number(r.api_call_count ?? 0),
        actualCostUsd: Number(r.actual_cost_usd ?? 0),
        // Hermes stores epoch *seconds*; normalize to epoch-ms for forecasting
        firstSeen: r.first_seen != null ? (r.first_seen < 1e12 ? r.first_seen * 1000 : r.first_seen) : undefined,
        lastSeen: r.last_seen != null ? r.last_seen * (r.last_seen < 1e12 ? 1000 : 1) : undefined,
      }));
    } catch (e) {
      console.error("[harness:hermes]", (e as Error).message);
      return [];
    }
  },
};

const claudeCode: HarnessAdapter = {
  id: "claude-code",
  label: "Claude Code",
  detect: () => existsSync(join(HOME, ".claude", "projects")),
  ingest(): UsageRecord[] {
    const out: UsageRecord[] = [];
    try {
      for (const file of walkJsonl(join(HOME, ".claude", "projects"))) {
        const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
        for (const line of lines) {
          try {
            const obj = JSON.parse(line) as ClaudeJsonlLine;
            const usage = obj.message?.usage;
            if (!usage) continue;
            out.push({
              harness: "claude-code",
              sessionRef: file.split("/").pop() ?? file,
              model: obj.message?.model ?? "unknown",
              inputTokens: usage.input_tokens ?? 0,
              outputTokens: usage.output_tokens ?? 0,
              cacheReadTokens: usage.cache_read_input_tokens ?? 0,
              cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
              apiCalls: 1,
              actualCostUsd: 0,
            });
          } catch { continue; }
        }
      }
    } catch (e) {
      console.error("[harness:claude-code] ingest failed:", (e as Error).message);
    }
    return out;
  },
};

const codex: HarnessAdapter = {
  id: "codex",
  label: "Codex CLI",
  detect: () => existsSync(join(HOME, ".codex", "sessions")),
  ingest(): UsageRecord[] {
    const out: UsageRecord[] = [];
    for (const file of walkJsonl(join(HOME, ".codex", "sessions"))) {
      try {
        for (const line of readFileSync(file, "utf8").split("\n").filter(Boolean)) {
          let obj: any;
          try { obj = JSON.parse(line); } catch { continue; }
          if (obj.type === "event_msg" && obj.payload?.type === "token_count") {
            const u = obj.payload.info?.total_token_usage ?? obj.payload;
            out.push({
              harness: "codex",
              sessionRef: file.split("/").pop() ?? file,
              model: String(u.model ?? "unknown"),
              inputTokens: Number(u.input_tokens ?? 0),
              outputTokens: Number(u.output_tokens ?? 0),
              cacheReadTokens: Number(u.cached_input_tokens ?? 0),
              cacheWriteTokens: 0,
              apiCalls: 1,
              actualCostUsd: null,
            });
          }
        }
      } catch { /* skip file */ }
    }
    return out;
  },
};

const openclaw: HarnessAdapter = {
  id: "openclaw",
  label: "OpenClaw",
  detect: () => existsSync(join(HOME, ".openclaw")),
  ingest: () => [],
};

const cursor: HarnessAdapter = {
  id: "cursor",
  label: "Cursor",
  detect: () => existsSync(join(HOME, ".cursor")),
  ingest: () => [],
};

export const HARNESSES: HarnessAdapter[] = [hermes, claudeCode, codex, openclaw, cursor];

export function detectHarnesses(): HarnessInfo[] {
  return HARNESSES.map((h) => ({ id: h.id, label: h.label, detected: h.detect(), usageRows: 0 }));
}

export function ingestAll(): UsageRecord[] {
  const all: UsageRecord[] = [];
  for (const h of HARNESSES) {
    if (!h.detect()) continue;
    try { all.push(...h.ingest()); }
    catch (e) { console.error(`[harness:${h.id}]`, (e as Error).message); }
  }
  return all;
}

function walkJsonl(dir: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkJsonl(p));
    else if (entry.name.endsWith(".jsonl")) out.push(p);
  }
  return out;
}

interface ClaudeJsonlLine {
  message?: { usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }; model?: string };
}
