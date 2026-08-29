/**
 * Oracle — budget tracker. SQLite-backed, persists across sessions
 * (mirrors TrueForge's own local-mode storage philosophy).
 */

import { DatabaseSync } from "node:sqlite";
import type { HistoryRecord } from "./estimator.js";

export interface BudgetConfig {
  dailyBudgetUsd: number;
  sessionBudgetUsd: number;
  expensiveThresholdUsd: number;
  warningThresholdPct: number;
}

export const DEFAULT_BUDGET: BudgetConfig = {
  dailyBudgetUsd: 5.0,
  sessionBudgetUsd: 1.0,
  expensiveThresholdUsd: 0.5,
  warningThresholdPct: 80,
};

export interface BudgetStatus {
  sessionSpentUsd: number;
  dailySpentUsd: number;
  sessionRemainingUsd: number;
  dailyRemainingUsd: number;
  sessionPctUsed: number;
  dailyPctUsed: number;
  overBudget: boolean;
  warning: boolean;
}

export class BudgetTracker {
  private db: DatabaseSync;

  constructor(dbPath = "oracle.db") {
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS spend (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        task_description TEXT NOT NULL,
        model TEXT NOT NULL,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        cost_usd REAL NOT NULL,
        timestamp INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS approvals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        action TEXT NOT NULL,
        estimated_cost_usd REAL NOT NULL,
        decision TEXT NOT NULL,
        reason TEXT,
        timestamp INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_spend_ts ON spend(timestamp);
      CREATE INDEX IF NOT EXISTS idx_spend_session ON spend(session_id);
    `);
  }

  logSpend(sessionId: string, record: Omit<HistoryRecord, "timestamp" | "taskHash">): void {
    this.db
      .prepare(
        `INSERT INTO spend (session_id, task_description, model, input_tokens, output_tokens, cost_usd, timestamp)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(sessionId, record.taskDescription, record.model, record.actualInputTokens, record.actualOutputTokens, record.actualCostUsd, Date.now());
  }

  logApproval(sessionId: string, action: string, estimatedCostUsd: number, decision: "approved" | "denied", reason?: string): void {
    this.db
      .prepare(`INSERT INTO approvals (session_id, action, estimated_cost_usd, decision, reason, timestamp) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(sessionId, action, estimatedCostUsd, decision, reason ?? null, Date.now());
  }

  getStatus(sessionId: string, config: BudgetConfig = DEFAULT_BUDGET): BudgetStatus {
    const dayStart = new Date().setHours(0, 0, 0, 0);
    const session = this.db
      .prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS total FROM spend WHERE session_id = ?`)
      .get(sessionId) as unknown as { total: number };
    const daily = this.db
      .prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS total FROM spend WHERE timestamp >= ?`)
      .get(dayStart) as unknown as { total: number };

    const sessionPct = (session.total / config.sessionBudgetUsd) * 100;
    const dailyPct = (daily.total / config.dailyBudgetUsd) * 100;

    return {
      sessionSpentUsd: round4(session.total),
      dailySpentUsd: round4(daily.total),
      sessionRemainingUsd: round4(Math.max(0, config.sessionBudgetUsd - session.total)),
      dailyRemainingUsd: round4(Math.max(0, config.dailyBudgetUsd - daily.total)),
      sessionPctUsed: Math.round(sessionPct),
      dailyPctUsed: Math.round(dailyPct),
      overBudget: session.total >= config.sessionBudgetUsd || daily.total >= config.dailyBudgetUsd,
      warning: sessionPct >= config.warningThresholdPct || dailyPct >= config.warningThresholdPct,
    };
  }

  getHistory(limit = 200): HistoryRecord[] {
    return this.db
      .prepare(`SELECT task_description AS taskDescription, model, input_tokens AS actualInputTokens, output_tokens AS actualOutputTokens, cost_usd AS actualCostUsd, timestamp FROM spend ORDER BY timestamp DESC LIMIT ?`)
      .all(limit) as unknown as HistoryRecord[];
  }

  getReport(sessionId?: string): { totalUsd: number; byModel: Record<string, number>; topTasks: Array<{ task: string; costUsd: number }> } {
    const where = sessionId ? `WHERE session_id = '${sessionId.replace(/'/g, "''")}'` : "";
    const total = (this.db.prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS t FROM spend ${where}`).get() as unknown as { t: number }).t;
    const byModelRows = this.db.prepare(`SELECT model, SUM(cost_usd) AS c FROM spend ${where} GROUP BY model`).all() as unknown as Array<{ model: string; c: number }>;
    const topTasks = this.db
      .prepare(`SELECT task_description AS task, SUM(cost_usd) AS costUsd FROM spend ${where} GROUP BY task_description ORDER BY costUsd DESC LIMIT 5`)
      .all() as unknown as Array<{ task: string; costUsd: number }>;

    return {
      totalUsd: round4(total),
      byModel: Object.fromEntries(byModelRows.map((r) => [r.model, round4(r.c)])),
      topTasks: topTasks.map((t) => ({ task: t.task, costUsd: round4(t.costUsd) })),
    };
  }

  close(): void {
    this.db.close();
  }
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
