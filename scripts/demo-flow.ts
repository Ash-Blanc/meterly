/**
 * Demo flow — the 3-minute video script, automated.
 *
 * Prerequisites:
 *   1. TrueForge running:  npx @truefoundry/trueforge  (localhost:8790)
 *   2. Model provider configured in Settings → Models (e.g. OpenAI)
 *   3. Meterly MCP server running:  npm run mcp:dev  (localhost:3001)
 *   4. meterly-cost registered in Settings → Connectors
 *
 * Run: npm run demo
 */

import { TrueForge } from "@truefoundry/trueforge-sdk";

const client = new TrueForge({
  baseUrl: process.env.TRUEFORGE_BASE_URL ?? "http://localhost:8790",
});

const MAIN_AGENT = {
  spec: {
    model: { name: "openai/gpt-4o-mini" },
    instructions: `You are a research agent with a cost conscience. Before ANY expensive action (spawning subagents, long research, multiple tool calls), you MUST consult Meterly:
1. Call estimate_cost with your plan.
2. If requiresApproval is true, call request_approval and wait. If denied, find a cheaper approach.
3. After completing work, call log_spend with actual usage.
Never spend more than $0.50 without human approval. Always show the price tag.`,
    mcpServers: [
      {
        name: "meterly-cost",
        enableTools: ["estimate_cost", "check_budget", "get_spend_report", "request_approval", "log_spend"],
        requireApprovalForTools: ["request_approval", "log_spend"],
      },
    ],
  },
};

async function main() {
  console.log("🎬 Meterly demo\n");

  const sessionResp = await client.sessions.create({ agent: MAIN_AGENT });
  const sessionId = sessionResp.data.id;
  console.log(`Session: ${sessionId}\n`);

  const prompt = `Research the current state of agent harness frameworks. I'm thinking of spawning 4 subagents to cover: (1) TrueForge, (2) LangGraph, (3) CrewAI, (4) AutoGen. Give me a comparison at the end.`;

  console.log(`User: ${prompt}\n`);
  console.log("─".repeat(60));

  const stream = await client.sessions.createTurnStream(sessionId, {
    input: [{ type: "user.message", content: prompt }],
  });

  // Track REAL usage from model.message events — no agent self-reporting.
  let totalInput = 0;
  let totalOutput = 0;
  const modelName = MAIN_AGENT.spec.model.name.split("/").pop() ?? "unknown";
  const perModel = new Map<string, { input: number; output: number }>();

  for await (const event of stream) {
    const e = event as unknown as Record<string, unknown>;
    const t = String(e.type ?? "");
    if (t.includes("text") || t.includes("delta")) process.stdout.write(String(e.text ?? e.delta ?? ""));
    else if (t.includes("tool")) console.log(`\n🔧 ${t}: ${JSON.stringify(e).slice(0, 200)}`);
    else if (t.includes("approval")) console.log(`\n⏸  ${t}: ${JSON.stringify(e).slice(0, 200)}`);
    else if (t.includes("subagent")) console.log(`\n🤖 ${t}`);
    else if (t === "model.message" && e.usage) {
      const u = e.usage as { inputTokens?: number; outputTokens?: number };
      totalInput += u.inputTokens ?? 0;
      totalOutput += u.outputTokens ?? 0;
      // Per-thread breakdown: subagent calls appear as separate threads
      const thread = String(e.threadId ?? "main");
      const cur = perModel.get(thread) ?? { input: 0, output: 0 };
      cur.input += u.inputTokens ?? 0;
      cur.output += u.outputTokens ?? 0;
      perModel.set(thread, cur);
    }
  }

  // Log REAL spend to Meterly — actuals from the harness, not guesses.
  if (totalInput > 0) {
    const { actualCost } = await import("../mcp-server/src/estimator.js");
    const cost = actualCost(modelName, totalInput, totalOutput);
    console.log(`\n\n📊 Real usage: ${totalInput} in / ${totalOutput} out → $${cost.toFixed(4)}`);
    if (perModel.size > 1) {
      for (const [thread, u] of perModel) {
        const c = actualCost(modelName, u.input, u.output);
        console.log(`   ${thread === "main" ? "main agent" : `subagent ${thread.slice(0, 8)}`}: ${u.input} in / ${u.output} out → $${c.toFixed(4)}`);
      }
    }

    // Call Meterly's log_spend via MCP (same as the agent would, but with real numbers)
    const mcpRes = await fetch("http://localhost:3001/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 2, method: "tools/call",
        params: { name: "log_spend", arguments: {
          taskDescription: prompt.slice(0, 120),
          model: modelName,
          inputTokens: totalInput,
          outputTokens: totalOutput,
          sessionId: sessionId,
        }},
      }),
    });
    const mcpText = await mcpRes.text();
    const match = mcpText.match(/"loggedCostUsd":([\d.]+)/);
    if (match) console.log(`✅ Meterly logged: $${match[1]}`);
  }

  console.log("\n" + "─".repeat(60));
  console.log("\n✅ Demo complete. Check the dashboard at http://localhost:3000");
}

main().catch((err) => {
  console.error("Demo failed:", err?.message ?? err);
  process.exit(1);
});
