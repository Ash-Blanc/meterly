/**
 * Oracle MCP server — exposes cost tools over MCP (Streamable HTTP).
 * Register this in TrueForge under Settings → Connectors → Add MCP Server.
 *
 * Tools:
 *   estimate_cost   — estimate USD cost of a proposed action (read-only, runs freely)
 *   check_budget    — current budget status (read-only)
 *   get_spend_report— spend breakdown (read-only)
 *   request_approval— pause for human approval before an expensive action (gated)
 *   log_spend       — record actual spend after an action (gated)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import express from "express";
import path from "node:path";
import { existsSync } from "node:fs";
import { estimateCost, actualCost } from "./estimator.js";
import { BudgetTracker, DEFAULT_BUDGET } from "./budget.js";

const tracker = new BudgetTracker(process.env.ORACLE_DB ?? "oracle.db");
const pendingApprovals = new Map<string, { resolve: (decision: { approved: boolean; reason?: string }) => void; action: string; costUsd: number }>();

const server = new McpServer({ name: "oracle-cost", version: "0.1.0" });

// ---------- Read-only tools (no approval needed) ----------

server.registerTool(
  "estimate_cost",
  {
    title: "Estimate Cost",
    description: "Estimate the USD cost of a proposed LLM action before executing it. Always call this before expensive operations (multi-subagent fan-out, long research tasks, gpt-4o-class calls).",
    inputSchema: {
      model: z.string().describe("Model ID, e.g. gpt-4o-mini"),
      taskDescription: z.string().describe("What the agent is about to do"),
      numToolCalls: z.number().optional().describe("Planned tool calls"),
      numSubagents: z.number().optional().describe("Planned subagents (default 1)"),
      expectedOutputLength: z.enum(["short", "medium", "long"]).optional(),
    },
    annotations: { readOnlyHint: true },
  },
  async (input) => {
    const estimate = estimateCost(input, tracker.getHistory());
    const status = tracker.getStatus("current");
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              ...estimate,
              budgetContext: {
                sessionRemainingUsd: status.sessionRemainingUsd,
                exceedsSessionBudget: estimate.estimatedCostUsd > status.sessionRemainingUsd,
                requiresApproval: estimate.estimatedCostUsd >= DEFAULT_BUDGET.expensiveThresholdUsd,
              },
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

server.registerTool(
  "check_budget",
  {
    title: "Check Budget",
    description: "Get current spend vs budget for this session and today.",
    inputSchema: {
      sessionId: z.string().optional().describe("Session ID (defaults to 'current')"),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ sessionId }) => {
    const status = tracker.getStatus(sessionId ?? "current");
    return { content: [{ type: "text", text: JSON.stringify(status, null, 2) }] };
  }
);

server.registerTool(
  "get_spend_report",
  {
    title: "Spend Report",
    description: "Breakdown of spend: total, by model, top tasks. Use for end-of-day summaries.",
    inputSchema: { sessionId: z.string().optional() },
    annotations: { readOnlyHint: true },
  },
  async ({ sessionId }) => {
    const report = tracker.getReport(sessionId);
    return { content: [{ type: "text", text: JSON.stringify(report, null, 2) }] };
  }
);

// ---------- Gated tools (TrueForge approval gate pauses these) ----------

server.registerTool(
  "request_approval",
  {
    title: "Request Approval",
    description: "Pause and ask the human to approve an expensive action. Call this when estimated cost exceeds the expensive threshold or the budget is nearly exhausted. The action does NOT proceed until a human approves.",
    inputSchema: {
      action: z.string().describe("The action awaiting approval"),
      estimatedCostUsd: z.number().describe("Estimated cost from estimate_cost"),
      reason: z.string().optional().describe("Why this action is worth the cost"),
    },
    // Deliberately NOT marked read-only — TrueForge gates it via agent's requireApprovalFor
  },
  async ({ action, estimatedCostUsd, reason }) => {
    const approvalId = crypto.randomUUID();
    // Broadcast to dashboard via SSE (see /approvals/stream below)
    broadcast({ type: "approval_requested", approvalId, action, estimatedCostUsd, reason, timestamp: Date.now() });

    const decision = await new Promise<{ approved: boolean; reason?: string }>((resolve) => {
      pendingApprovals.set(approvalId, { resolve, action, costUsd: estimatedCostUsd });
      // Auto-deny after 5 minutes so agents don't hang forever
      setTimeout(() => {
        if (pendingApprovals.delete(approvalId)) resolve({ approved: false, reason: "timeout" });
      }, 5 * 60 * 1000);
    });

    tracker.logApproval("current", action, estimatedCostUsd, decision.approved ? "approved" : "denied", decision.reason);
    broadcast({ type: "approval_resolved", approvalId, approved: decision.approved });

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ approvalId, approved: decision.approved, reason: decision.reason ?? null }, null, 2),
        },
      ],
    };
  }
);

server.registerTool(
  "log_spend",
  {
    title: "Log Spend",
    description: "Record actual token spend after an action completes. Feeds Oracle's learning loop so future estimates improve.",
    inputSchema: {
      taskDescription: z.string(),
      model: z.string(),
      inputTokens: z.number(),
      outputTokens: z.number(),
      sessionId: z.string().optional(),
    },
  },
  async ({ taskDescription, model, inputTokens, outputTokens, sessionId }) => {
    const cost = actualCost(model, inputTokens, outputTokens);
    tracker.logSpend(sessionId ?? "current", {
      taskDescription,
      model,
      actualInputTokens: inputTokens,
      actualOutputTokens: outputTokens,
      actualCostUsd: cost,
    });
    broadcast({ type: "spend_logged", costUsd: cost, taskDescription });
    return { content: [{ type: "text", text: JSON.stringify({ loggedCostUsd: cost }) }] };
  }
);

// ---------- HTTP transport + dashboard SSE ----------

const sseClients = new Set<express.Response>();
function broadcast(event: unknown) {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of sseClients) res.write(data);
}

const app = express();
app.use(express.json());

// Serve the dashboard from the same origin — one process, one port, `bun dev` just works.
const dashboardDir = existsSync("dashboard") ? "dashboard" : "../dashboard";
app.use(express.static(dashboardDir));
app.get("/", (_req, res) => res.sendFile(`${dashboardDir}/index.html`, { root: process.cwd() }));

app.post("/mcp", async (req, res) => {
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => transport.close());
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

// Dashboard event stream
app.get("/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.flushHeaders();
  sseClients.add(res);
  req.on("close", () => sseClients.delete(res));
});

// Dashboard resolves approvals
app.post("/approvals/:id", (req, res) => {
  const pending = pendingApprovals.get(req.params.id);
  if (!pending) return res.status(404).json({ error: "approval not found or already resolved" });
  pendingApprovals.delete(req.params.id);
  const { approved, reason } = req.body as { approved: boolean; reason?: string };
  pending.resolve({ approved: Boolean(approved), reason });
  res.json({ ok: true });
});

// Dashboard data
app.get("/status", (_req, res) => {
  res.json({ budget: tracker.getStatus("current"), report: tracker.getReport() });
});

const port = Number(process.env.ORACLE_MCP_PORT ?? 3001);
app.listen(port, () => console.log(`oracle-cost MCP server on http://localhost:${port}/mcp`));
