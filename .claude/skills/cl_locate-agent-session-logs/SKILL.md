---
name: cl_locate-agent-session-logs
description: Use whenever you touch how Canary finds, reads, or builds a path to a claude/codex CLI session log (the JSONL behind AgentSessionView), before recomputing any ~/.claude/projects/... or ~/.codex/sessions/... path by hand, or when an agent view is "blank" / "stuck" / "only works on my machine".
---

# Canary Lab — Locating Agent Session Logs

Not for designing what an agent viewer *shows* → `cl_surfacing-agent-work`. And note
MCP external runs have no session log at all — a blank `ExternalXXXPanel` is not a
path bug.

Canary never scrapes a terminal to display agent output. Each agent CLI
**writes its own JSONL transcript to disk**; Canary just needs the *path*, then
`loadAgentSession` parses it and `AgentSessionView` renders it. Every bug in this
area is really "Canary looked in the wrong place" → a silently-blank viewer that
reads as *"the agent produced nothing"* rather than *"we couldn't find the log"*.

## Where each CLI writes (hardcoded knowledge, not discovered)

```
claude  →  <claude-config-dir>/projects/<encoded-cwd>/<session-uuid>.jsonl
codex   →  <codex-config-dir>/sessions/YYYY/MM/DD/rollout-<iso>-<id>.jsonl
```

- These layouts are **observed conventions** of the published CLIs, baked in as
  constants. There is no API that reports them.
- **claude is deterministic**: Canary mints the uuid (`randomUUID()`) and pins it
  with `--session-id`, so the path is computable before the agent finishes.
- **codex is discovered**: no `--session-id` flag, so Canary scans the
  date-bucketed dir and matches on `realpath(cwd)` + start timestamp.

## The config dir is relocatable — resolve it the way the CLI does

Both CLIs let you move their config/session home via an env var. Hardcoding the
default dotdir silently breaks lookup when a user relocates it.

| CLI | Env override | Resolver (one home) |
| --- | --- | --- |
| claude | `CLAUDE_CONFIG_DIR` | `claudeConfigDir(homeDir)` |
| codex | `CODEX_HOME` | `codexConfigDir(homeDir)` |

Both live in `agent-session-log.ts` and return the override (trimmed, non-empty)
else `path.join(homeDir, '.claude' | '.codex')`.

(All basenames in this skill — `agent-session-log.ts`, `agent-config-env.ts`,
`agent-session-tailer.ts`, their tests — live under
`apps/web-server/src/features/agent-sessions/logic/` unless a path prefix says
otherwise.)

## Rules

- **Never recompute a session-log path by hand.** Building
  `path.join(home, '.claude', 'projects', …)` or reading `process.env.HOME`
  inline is the recurring smell — it skips the env override, the realpath, and
  the project-dir slug encoding, and it drifts from the canonical version.
  Route through:
  - `claudeSessionLogPath(cwd, sessionId)` — the deterministic claude path
  - `claudeConfigDir()` / `codexConfigDir()` — the config-dir base
  - the existing locators (`findClaudeLogBySessionId`, `locateCodexSessionLog`,
    `locateLatest*`, `resolveManifestSessionRef`, `resolveWorkflowAgentRef`)
- **The slug is not `/`→`-`, and it has already changed once.** claude 2.1.220
  folds **every** non-alphanumeric character to `-` (`/var/folders/s_/x` →
  `-var-folders-s--x`); older builds folded only `/`, leaving `.` and `_`
  intact. Treat the slug as a **guess at someone else's private format**:
  - **Prefer the session id whenever you have one.** It's ours, pinned via
    `--session-id`, globally unique, and encoding-proof.
    `locateClaudeSessionLog` falls back to `findClaudeLogBySessionId` for
    exactly this reason.
  - **When you have no id**, try `claudeProjectDirCandidates(cwd)` (current slug
    then legacy) rather than one encoding — a run straddling a CLI upgrade has
    logs under both.
  - The failure mode is the usual one: log on disk, viewer blank. Workspace run
    dirs have no `_`, while every macOS temp dir (`/var/folders/s_/…`) does —
    so it bites demo, smoke, and temp-dir flight runs first.
- **In session-log / config-dir path code, the `.claude` / `.codex` string
  literals belong in exactly two places** — the fallback inside the two
  resolvers. If a literal appears anywhere else on a path that will be *read
  back* to find a log, it's a stray; fold it into the resolver.
  Known occurrences *outside* this rule's scope: the skill-install destination
  paths in `apps/cli/agent.ts` (`path.join(home, '.codex'|'.claude', 'skills',
  …)`) and the CLI-presence detection checks in `apps/cli/setup.ts`
  (`fs.existsSync(path.join(homeDir, '.codex'|'.claude'))`). These are
  install-time paths, not session-log lookups — but note they currently
  ignore `CLAUDE_CONFIG_DIR` / `CODEX_HOME`, so a relocated config home gets
  skills installed under the default dotdir. If you touch them, route through
  the resolvers rather than adding more literals.

## Why lookup stays correct: everything keys off `process.env`

The spawn side and the read side must agree on the config dir. They do because
**both resolve from `process.env`**, and the server process that reads a log is
the same process that spawned the agent:

- **headless agents** (coverage / portify / benchmark / flight stages) inherit
  `process.env` directly via `child_process`.
- **the PTY heal agent** runs under `$SHELL -i -c`, which sources the rc file
  (.zshrc/.bashrc).

The one gap that breaks the in-process guarantee: the **rc file sets
`CLAUDE_CONFIG_DIR` / `CODEX_HOME` but the env that launched the server did
not** (e.g. set only for interactive shells, or Canary launched from a context
that didn't source the rc). Then the PTY agent writes under the rc-configured
home while the server looks under the default.

## The fix for that gap: hydrate at boot, once

`hydrateAgentConfigEnvFromShell()` (`agent-config-env.ts`), called from
`apps/cli/ui-command.ts` before any agent spawns:

- probes the interactive shell **once** (`$SHELL -i -c`, marker-fenced output,
  bounded timeout) for the vars **missing** from the launching env;
- back-fills any it finds into `process.env`.

After that, PTY + headless + read-side all resolve the same home. It's
best-effort (a probe failure leaves the env as-is) and a no-op when the launching
env already carries the vars (the common case — no shell spawned).

**Design constraints to preserve if you touch this:**
- **Discover, don't force.** Do not force `CLAUDE_CONFIG_DIR` to a Canary-chosen
  value — relocating claude's home severs its auth/credentials and the agent
  fails to launch. Read the user's *own* effective value.
- **Only probe for missing vars.** Re-running the shell when the env already has
  them adds boot latency for nothing.
- **Keep `run` injectable.** Tests pass a fake probe; never spawn a real shell in
  a unit test.

## Failure-mode triage (user says "the agent view is blank")

1. Is this the **MCP external path**? Then there's no log to find — the client
   submits results via `submit_external_*`; AgentSessionView isn't the surface.
   (See `cl_surfacing-agent-work`.)
2. Server-spawned path: does the log file exist on disk where the resolver looks?
   Check `CLAUDE_CONFIG_DIR` / `CODEX_HOME` in the env the **server** runs under
   vs. what the agent's shell resolves.
3. codex only: the discovery match is `realpath(cwd)` + `timestamp >= start` — a
   cwd symlink mismatch or a clock/timezone skew drops the match.

## Verify
- `agent-session-log.test.ts` and `agent-config-env.test.ts` cover the resolvers
  + hydration; run them plus `apps/cli/ui-command.test.ts` for the boot wiring.
- `agent-session-log.ts` / `ui-command.ts` are `apps/web-server/**` + `apps/cli/`
  changes → only take effect after the `canary-apply` cycle (`cl_verify-changes`
  Tier 3).
