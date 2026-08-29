/**
 * Demo flow — the 3-minute video script, automated.
 *
 * Prerequisites:
 *   1. TrueForge running:  npx @truefoundry/trueforge  (localhost:8790)
 *   2. Model provider configured in Settings → Models (e.g. OpenAI)
 *   3. Oracle MCP server running:  npm run mcp:dev  (localhost:3001)
 *   4. oracle-cost registered in Settings → Connectors
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
    instructions: `You are a research agent with a cost conscience. Before ANY expensive action (spawning subagents, long research, multiple tool calls), you MUST consult Oracle:
1. Call estimate_cost with your plan.
2. If requiresApproval is true, call request_approval and wait. If denied, find a cheaper approach.
3. After completing work, call log_spend with actual usage.
Never spend more than $0.50 without human approval. Always show the price tag.`,
    mcpServers: [
      {
        name: "oracle-cost",
        enableTools: ["estimate_cost", "check_budget", "get_spend_report", "request_approval", "log_spend"],
        requireApprovalForTools: ["request_approval", "log_spend"],
      },
    ],
  },
};

async function main() {
  console.log("🎬 Oracle Sidecar demo\n");

  const sessionResp = await client.sessions.create({ agent: MAIN_AGENT });
  const sessionId = sessionResp.data.id;
  console.log(`Session: ${sessionId}\n`);

  const prompt = `Research the current state of agent harness frameworks. I'm thinking of spawning 4 subagents to cover: (1) TrueForge, (2) LangGraph, (3) CrewAI, (4) AutoGen. Give me a comparison at the end.`;

  console.log(`User: ${prompt}\n`);
  console.log("─".repeat(60));

  const stream = await client.sessions.createTurnStream(sessionId, {
    input: [{ type: "user.message", content: prompt }],
  });

  for await (const event of stream) {
    const e = event as unknown as Record<string, unknown>;
    const t = String(e.type ?? "");
    if (t.includes("text") || t.includes("delta")) process.stdout.write(String(e.text ?? e.delta ?? ""));
    else if (t.includes("tool")) console.log(`\n🔧 ${t}: ${JSON.stringify(e).slice(0, 200)}`);
    else if (t.includes("approval")) console.log(`\n⏸  ${t}: ${JSON.stringify(e).slice(0, 200)}`);
    else if (t.includes("subagent")) console.log(`\n🤖 ${t}`);
  }

  console.log("\n" + "─".repeat(60));
  console.log("\n✅ Demo complete. Check the dashboard at http://localhost:3000");
}

main().catch((err) => {
  console.error("Demo failed:", err?.message ?? err);
  process.exit(1);
});
