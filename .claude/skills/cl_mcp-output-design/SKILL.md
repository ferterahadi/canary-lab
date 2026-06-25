---
name: cl_mcp-output-design
description: Project-specific corrections about Canary Lab MCP tool OUTPUT design — what and how much a tool returns into the agent's context. Learned conventions for sizing/shaping agent-facing payloads. Consult before adding or reshaping any MCP tool result.
---

# MCP output design — learned conventions

Corrections captured via /todo-learn. Each is a standing rule for this repo.

## 2026-06-25 — Size inline payloads to the agent's token budget, not the transport limit
- **Rule:** When deciding how much content to inline in an MCP tool result, the budget is **what the agent can comfortably consume in one tool call** (token cost), NOT "what won't break the JSON-RPC transport." Keep inline budgets small (Canary's `get_failure_detail` uses **8 KB ≈ 2K tokens**); past the budget, return a file **path** and let the agent `Read` it in chunks (offset/limit) — never truncate the text mid-stream.
- **Why:** An MCP tool result lands directly in the agent's context window. 512 KB ≈ 131K tokens would eat a huge slice of the window in a single call — useless even though it "fits" the transport. The binding constraint is context/token cost, and the agent's `Read` tool already pages large files, so a pointer is strictly better than a large inline blob.
- **How to apply:** Choosing/justifying an inline-size constant for any agent-facing payload (error text, logs, diffs, snapshots, summaries) → set it in the single-digit-KB range and reason in *tokens* (~4 chars/token), not bytes-vs-transport. If content can exceed that, omit it and surface a path/flag (`includeRaw`/`includeDiff`/`...Path`) so the agent pulls the full content on demand. Don't frame a size ceiling as a "pathological / won't-break-the-response guard" — that's the wrong mental model. See also [[cl_add-mcp-tool]], [[cl_sync-agent-surfaces]].
