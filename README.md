# ◈ Oracle Sidecar

**A cost-aware sidecar agent for TrueForge.** Oracle sits next to any agent and whispers the price tag before every expensive action — then pauses for human approval when the spend gets serious. It never does the task itself. It makes the agent that does the task smarter about money.

Built for [The Agent Harness Hackathon](https://www.wemakedevs.org/hackathons/trueforge) (WeMakeDevs × TrueFoundry).

## The problem

Agents burn tokens invisibly. You ask for a "quick comparison," the agent spawns four subagents, fans out twenty tool calls, and you find out what it cost when the invoice arrives. Every agent framework treats cost as an observability problem — something you review *after*. Oracle treats it as a **control problem** — something the agent must reason about *before* acting.

## How it works

Oracle is a TrueForge agent plus an MCP server (`oracle-cost`) exposing five tools:

| Tool | Type | Purpose |
|------|------|---------|
| `estimate_cost` | read-only | Price a proposed action before executing — model, tool calls, subagent fan-out |
| `check_budget` | read-only | Session + daily spend vs budget |
| `get_spend_report` | read-only | Breakdown by model, top tasks |
| `request_approval` | **gated** | Pauses the run until a human clicks Approve/Deny in the dashboard |
| `log_spend` | **gated** | Records actual usage; feeds the learning loop |

The gated tools are enforced by **TrueForge's tool-approval mechanism** (`requireApprovalFor`), not by convention — the harness halts the turn and emits `approval_required` before they execute.

The estimator **learns**: every `log_spend` call adds to a history table, and future estimates blend naive token math with observed actuals for similar tasks.

## Architecture

```
┌────────────────┐   MCP tools   ┌──────────────────────────────┐
│  Main agent    │──────────────▶│  oracle-cost MCP + dashboard │
│  (any task)    │               │  :3001  (bun dev = one proc) │
│                │◀──────────────│                              │
└───────┬────────┘   estimates   └────────┬─────────────────────┘
        │                                 │ SSE events + approvals
        ▼                                 ▼
┌────────────────────────────────┐  ┌──────────────────────────────┐
│  TrueForge harness (:8790)     │  │  Dashboard (same origin)     │
│  • approval gate on gated tools│  │  • live ticker + count-ups   │
│  • persistent sessions         │  │  • approve / deny (↵ / esc)  │
│  • sandbox, subagents          │  │  • spend report              │
└────────────────────────────────┘  └──────────────────────────────┘
```

## Quickstart

Prereqs: Node 22+ or bun. **The dashboard ships inside the MCP server** — one process serves both the API and the UI.

```bash
# 1. Install + run — dashboard AND MCP server on one port
bun install && bun dev              # → http://localhost:3001 (dashboard + MCP + SSE)

# Optional, for a richer history on first run:
bun run seed                        # seeds realistic spend history

# 2. Wire it into TrueForge (separate terminal)
npx @truefoundry/trueforge          # → http://localhost:8790
#    Settings → Models     → add your provider
#    Settings → Connectors → Add MCP Server → http://localhost:3001/mcp

# 3. Run the scripted demo
bun run demo
```

## Demo script (the 3-minute video)

1. **Price tag before action** — main agent proposes a 4-subagent research fan-out; Oracle estimates $0.24 before anything runs.
2. **Cheaper path** — Oracle suggests consolidating to 2 subagents (saves ~45%); the agent takes the advice.
3. **Approval gate** — a follow-up exceeds the $0.50 threshold; the dashboard modal appears, the run *waits*, human approves, run resumes.
4. **Learning loop** — actual spend logged, next estimate for a similar task tightens.
5. **End-of-day report** — total spend, by model, top tasks.

## What TrueForge is doing (for judges)

- **MCP tools**: the entire Oracle surface is a real MCP server over Streamable HTTP
- **Approval gate**: `request_approval` / `log_spend` gated via `requireApprovalFor` — enforced by the harness, not the prompt
- **Sandbox**: estimator experiments (pricing model tweaks) run sandboxed
- **Subagents**: main agent's fan-out is the thing Oracle prices and optimizes
- **Persistent sessions**: budget state survives reconnects (SQLite, same philosophy as TrueForge local mode)

## Qodo Code Review Evidence

<!-- Fill in after first merged PR. Example:
- Representative PR: https://github.com/<you>/oracle-sidecar/pull/3
- Qodo flagged a SQL-injection risk in the report query (string interpolation); fixed with parameterized queries.
- Dismissed one Low finding on `any` in the SSE handler (typed events land in PR #5).
-->

_To be completed during the hackathon — every substantive change lands via a Qodo-reviewed PR._

## License

MIT
