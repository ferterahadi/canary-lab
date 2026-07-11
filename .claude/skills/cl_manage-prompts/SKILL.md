---
name: cl_manage-prompts
description: Use when adding, editing, or moving an LLM prompt an agent spawn sends (heal, wizard, portify, coverage/PRD, flights) — every prompt is a template file under apps/web-server/prompts/, never an inline string in a .ts file. NOT for MCP initialize instructions (REPAIR_INSTRUCTIONS etc. in apps/web-server/mcp/server.ts) or tool description fields in apps/web-server/mcp/tools.ts — those belong to cl_sync-agent-surfaces / cl_add-mcp-tool.
---

# Managing Canary Lab's LLM Prompts

Every prompt canary sends to a spawned agent (claude/codex) lives as a flat file
in `apps/web-server/prompts/` — never as a template literal or string constant
buried in a `.ts` file. One home, one loader:
[`apps/web-server/src/shared/prompts.ts`](../../../apps/web-server/src/shared/prompts.ts).

## Why prompts get their own folder

- **Ships via build, like templates.** `tools/prepare-assets.mjs` copies the
  whole folder into `dist/apps/web-server/prompts/` — the same mechanism
  `templates/project/` uses. A prompt inlined in a `.ts` file ships fine too, but
  hides among logic instead of reading as a first-class asset.
- **Diffable prose.** A `.md` prompt reviews like copy, not like code — no
  string-escaping noise, no `+`/backtick clutter for a paragraph edit.
- **One loader, one contract.** All templates share the same `{{placeholder}}`
  substitution rules (see below) instead of five call sites each rolling a
  slightly different `replace(/\{\{(\w+)\}\}/g, ...)`.

## Adding a new prompt

1. Write the prompt as `apps/web-server/prompts/<name>.md`, with `{{placeholder}}`
   slots for the parts the caller fills in at runtime.
2. If the agent must return structured output validated against a JSON schema
   (codex's `--output-schema`), add a sibling `apps/web-server/prompts/<name>.schema.json`
   (see `coverage-annotate.schema.json`, `prd-summary.schema.json`,
   `evaluation-rewrite.schema.json`). Prompts that instead ask the agent to
   reply in a ` ```json ` fence (parsed with `extractJson`/hand-rolled parsing —
   see `scout.md`, `stage1-plan.md`) don't need one.
3. In the `.ts` module that builds the prompt, import from
   `../../../shared/prompts` (adjust `../` depth to reach `apps/web-server/src/shared/`)
   and use:
   - `promptPath(name)` — resolve `<name>` to its absolute path in the packaged
     prompts dir. Use this for a path you need to store/pass around (e.g. a
     manifest field re-read later), not just render once.
   - `renderPrompt(name, vars)` — the one-shot case: load + substitute in one call.
   - `loadPromptTemplate(path)` / `renderPromptTemplate(template, vars)` — the
     two steps split apart, for callers that accept an injected raw template
     string for tests (`buildPlanPrompt({ template: '...' })`) or that resolve
     the path dynamically (`opts.promptPath ?? DEFAULT_PATH`).
4. Never `fs.readFileSync` a prompt file directly, and never hand-roll another
   `{{key}}` regex — that's exactly the duplication this module replaced (six
   near-identical copies before the 2026-07 consolidation).

## The `{{placeholder}}` contract

- A placeholder embedded in other text (`- {{failedDir}}/<slug>/foo`) — the
  variable's string value is substituted in; a **missing** key is left as
  literal `{{key}}` text (an out-of-sync template degrades visibly instead of
  silently losing text).
- A line that holds **nothing but one placeholder** is dropped entirely when
  that placeholder is a **known** key resolving to `''` — this is how optional
  bullets/sections (e.g. `heal-agent.md`'s `{{traceExtractHint}}`) disappear
  cleanly instead of leaving a blank line. An **unknown** key on its own line
  is still left as literal text, same as the mixed-line case.
- Pass JSON payloads pre-stringified (`JSON.stringify(x, null, 2)`) as a plain
  string var — the loader does no JSON-awareness, it's pure text substitution.

## What does NOT belong in `prompts/`

| Lives here instead | Why it's a different thing |
| --- | --- |
| `apps/web-server/mcp/server.ts` — `REPAIR_INSTRUCTIONS`, `AUTHOR_INSTRUCTIONS`, etc. | MCP **protocol** instructions returned from `initialize` — part of the server's versioned API surface, not a per-spawn agent prompt. See `cl_sync-agent-surfaces`. |
| `apps/web-server/mcp/tools.ts` — tool `description:` fields | MCP tool schema metadata, not text sent to steer an agent's task. |
| `templates/project/` | Scaffold files copied into a user's *workspace* (feature configs, sample specs) — ships via the same build step, but it's product output, not a prompt. See `cl_add-sample-feature`. |
| `.claude/skills/**/SKILL.md` | Claude Code skill definitions for contributors working on canary-lab itself, not agent-spawn prompts. |

`apps/web-server/prompts/sabotage-skills/` is the one exception that still
lives *inside* `prompts/`: it's `meta.json` + `skill.md` pairs the benchmark
feature loads (`features/benchmark/logic/runtime/skills.ts`), shaped
differently from the flat `{{placeholder}}` templates because it isn't a
prompt — it's a structured skill definition bundled with the package for the
same reason prompts are (ships via `dist/apps/web-server/prompts/`, upgrades
with the package).

## Common mistakes

| Mistake | Consequence |
| --- | --- |
| Inlining a new agent prompt as a template literal in a `.ts` file | Works, but breaks the one-home rule — the next contributor won't think to look in `prompts/`, and it silently escapes the build's asset-copy step |
| Hand-rolling a new `{{key}}` substitution regex | Recreates the exact duplication this module consolidated; extend `renderPromptTemplate` instead if it's missing a capability |
| Assuming a solo-placeholder line is *always* droppable when empty | Only true for a **known** key; an unrecognized placeholder is deliberately kept (verified via `apps/web-server/src/shared/prompts.test.ts`) |
| Forgetting `npm run smoke:pack` after adding/renaming a `.md`/`.schema.json` file | `prepare-assets.mjs`'s copy step is only proven by the tarball smoke test, same as `templates/` |
