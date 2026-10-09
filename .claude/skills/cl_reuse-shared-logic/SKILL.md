---
name: cl_reuse-shared-logic
description: Use the moment you're about to add code or UI that resembles something already in the repo — a second agent spawn, a second pill/card/dialog, a second background store, a second stream parser, a second timeout. Find the existing one and reuse or extend it instead of writing a near-copy.
---

# Canary Lab — Reuse Over Duplication

Skip when the code is genuinely one-of-a-kind or the resemblance is superficial
(same shape, different concern). Styling → `cl_ui-design-philosophy`;
background-task lifecycle → `cl_async-task-ux`.

Related logic gets **one home**. Before adding a block that resembles an existing
one, find that one and reuse it — or extend it into a shared
helper/component/primitive that every site calls. A near-copy with a few lines
tweaked is a smell: the variants drift, and the same bug has to be fixed N times
(it has happened here — idle timeouts, stream-json, and answer-recovery were each
added to *some* agent spawns and not others, and the same SIGTERM bug recurred).

## The tell

If you're about to copy a block and change 2–3 lines, **stop**. That block wants
to be a function/component whose 2–3 differences are parameters. "It's only
slightly different" is how five slightly-different copies are born.

## Primitives that already exist — reuse, don't re-invent

| Concern | The one home | Don't |
| --- | --- | --- |
| Colour / spacing / radius / type | CSS tokens + layout precedents → `cl_ui-design-philosophy` | hardcode hex, add a UI kit |
| Long-running background task | file-backed store pattern → `cl_async-task-ux` | bespoke job tracking |
| **Spawn an agent CLI** (claude/codex) | `runAgentProcess` + `buildClaudeAgenticArgs` (`agent-sessions/logic/agent-process.ts`) | re-implement spawn + tee + idle |
| Read-only agent pass that answers with JSON | `runReadOnlyAnswerAgent` (`agent-sessions/logic/agent-completion.ts`) | rebuild the claude/codex read-only argv + session pin per caller |
| Idle / liveness timeout | `startIdleTimer` (`agent-sessions/logic/agent-idle-timer.ts`) | inline `setInterval` + `lastOutputAt` |
| Recover claude's answer from stream-json stdout | `recoverClaudeFinalText` (`agent-sessions/logic/agent-stream.ts`) | re-parse envelopes inline |
| Path of claude's session JSONL | `claudeSessionLogPath` (`agent-sessions/logic/agent-session-log.ts`) | recompute `~/.claude/projects/...` |
| Show an agent's progress/output | `AgentSessionView` + `tailAgentSession` → `cl_surfacing-agent-work` | a new viewer |
| Feature store wrapper over `FileBackedTaskStore` | `TaskListeners`, `rows()`, `legacyEntryId`, `abortOnRestart` (`shared/lib/file-backed-task-store.ts`) | a private listener `Set` + `emit`, a hand-rolled bookkeeping strip or restart reconcile |
| Record push channel (`/ws/<records>`) | `registerRecordStream` + `activeDetails`; any JSON frame via `sendFrame` (`apps/web-server/src/shared/ws/record-stream.ts`) | a per-stream try/`socket.send` closure |
| Look up one suite by name | `findFeature` (`apps/web-server/src/shared/feature-loader.ts`) | `loadFeatures(dir).find(...)` |
| Route 404 / failed handler | `return notFound(reply, 'run')`; a caught error → `replyFailure(reply, err, fallback?)`, its status → `statusCodeOf(err)` (`apps/web-server/src/shared/http-error.ts`) | `reply.code(404)` + a literal body, `(err as any).statusCode ?? 500` |
| Run artifact paths and verdict names | `runManifestPath` / `runSummaryPath` / `buildRunPaths` (`runs/logic/runtime/run-paths.ts`); `passedNames` / `failedNames` (`runs/logic/runtime/summary-names.ts`); pass/fail counts → `normalizeRunCounts` (`shared/run-counts.ts`) | `path.join(runDir, 'manifest.json')`, a private summary reader, counting a roster by hand |
| The running UI's address from a CLI command | `resolveServerBase(projectRoot, () => configPort)` (`shared/runtime/active-servers.ts`) | `http://localhost:${port}` from config alone |
| Small server utils | `newTaskId` / `newTimedTaskId` (`apps/web-server/src/shared/task-id.ts`); `createCappedDebounce` + `OBSERVATION_LEASE_MS` (`shared/debounced-watch.ts`); `appendJsonLine` (`shared/json-lines.ts`); `isAgentKind` (`agent-sessions/logic/agent-binary.ts`); `commandAvailable` (`shared/lib/command-available.ts`); `formatSize` / `formatMs` (`shared/lib/format-units.ts`) | a per-store id format, a hand-rolled `fs.watch` debounce, `appendFileSync(JSON.stringify(x) + '\n')`, `x === 'claude' \|\| x === 'codex'`, a `which` spawn |
| `tools/*.mjs` scripts | `REPO` + `walk` (`tools/lib/fs.mjs`), `git` (`tools/lib/git.mjs`), `runOrExit` (`tools/lib/run.mjs`) | `new URL(..).pathname` for the repo root, a private recursive walker |
| JSON file write | `atomicWriteJson` (`shared/lib/atomic-write.ts`); exact bytes → `atomicWrite` | tmp-then-rename by hand, or a bare `writeFileSync` of state a reader polls |
| Text of a caught error | `errorMessage(err, fallback?)` (`shared/lib/error-message.ts`); web UI → `displayError` (`apps/web/src/shared/api/error-message.ts`, reads the server's `reason`) | inline `err instanceof Error ? err.message : String(err)` |
| Diffs, blobs and one review side | apply or undo a diff's hunks → `applyHunks` (`shared/lib/unified-diff.ts`); a git blob's id or content → `gitBlobSha1` / `matchesBlob` (`apps/web-server/src/shared/git-blob.ts`), `readGitBlob` (`shared/git-repo.ts`); one review side's English and tests → `reviewSourceFor` (`apps/web-server/src/shared/readable-tests/review-source.ts`); a path confined to a root → `confinedFile` (`shared/path-containment.ts`) | `git apply` into a scratch tree to rebuild text, a private SHA-1 of `blob <n>\0`, `git show` trimmed through `runGitSync`, a second extractor + translator pairing |
| Best-effort file read / small Node utils | `readTextOrNull`, `readJsonOr` (`shared/lib/read-file-or.ts`); `sleep` (`shared/lib/sleep.ts`); `isRecord` (`shared/lib/is-record.ts`); `plural` / `pluralSuffix` (`shared/lib/plural.ts`) | a private `safeRead`, try/`JSON.parse`/catch, `new Promise(r => setTimeout(r, n))`, `n === 1 ? '' : 's'` |
| Web storage, clocks, formatting | `readStored`/`writeStored`/`usePersistedFlag` (`apps/web/src/shared/state/browser-storage.ts`); `useElapsed` (`shared/state/use-elapsed.ts`); `shortTime`, `formatSpan`, `shortSession`, `truncateText`, `firstLineOf`, `joinNatural` (`shared/lib/format.ts`); `clampToViewport` (`shared/lib/viewport.ts`) | a localStorage try/catch, a private elapsed hook, an inline `Intl` time or `Math.min(Math.max(8, x), …)` |
| Tab button / full-screen page | `Tab` (`apps/web/src/shared/ui/Tab.tsx`); `FullScreenPage` (`shared/ui/PageHeader.tsx`) | hand-written `.cl-tab` pairs, a `fixed inset-0 z-[60]` shell |
| App state for a leaf several components below App | the state is built once in `WorkspaceProvider` (`apps/web/src/WorkspaceProvider.tsx`); App reads `useWorkspace()`, leaves read `useWorkspaceActions` / `useWorkState` (`apps/web/src/shared/state/workspace-actions.tsx`, `work-state.tsx`); inside a flight stage `useFlightActions` (`features/flights/state/flight-actions.tsx`); a refetch trigger `useInvalidationKey` (`shared/state/invalidation.tsx`) | drill a prop through pass-through layers, call `useWorkspaceFlights` a second time, or read a context in a component App never wires (an absent action must keep hiding its affordance) |
| Test fakes | `makeFakePtyFactory`, `deferred`, `FakeWebSocket`, `demoFeature` / `writeFeatureFixture` (`tools/test-helpers/`); flight stage doubles in `flights/logic/stages/__fixtures__/`; MCP smoke harness in `mcp/__fixtures__/smoke-harness.ts`; `pollUntil` (`tools/test-helpers/poll-until.ts`); `captureEvents` (`apps/web-server/src/shared/__fixtures__/workspace-events.ts`); per-feature Fastify builders in `routes/__fixtures__/`; web: `mountRoot`, `advanceAct`, the shiki mock (`apps/web/src/test-helpers/`) — the dom project already sets `IS_REACT_ACT_ENVIRONMENT` | a per-file fake PTY, deferred, socket class, feature builder, poll loop, event recorder, `buildApp`, or act-flag line |
| MCP tool surface | `mcp/tool-groups/` + `tool-support.ts` registry → `cl_add-mcp-tool` | a parallel tool path |
| Web store fed by a full-manifest `/ws` stream | `createRecordIndex` + `useRecordIndexStore` + `useRecordDetail` (`apps/web/src/shared/state/record-index-store.ts`); `ConnectionState` lives in `record-stream.ts` | a per-feature reducer, hydration adapter and provider wiring |
| Test temp dir / real git repo | `trackTempDirs` (`tools/test-helpers/temp-dir.ts`); `initGitRepo` + `git` (`tools/test-helpers/git-repo.ts`) | a per-file `mkTmp` + cleanup loop, or a five-line `git init`/identity/commit block |
| Popover dismissal + placement | `useDismissOnOutsideMousedown` / `useEscapeToClose` (`apps/web/src/shared/ui/Overlays.tsx`), `useAnchoredPosition` (`shared/ui/use-anchored-position.ts`) | a raw `document` keydown/mousedown listener — it bypasses the Escape layer stack |

## The agent-process runner (consolidated — keep it that way)

**Every** agent-spawn site composes `runAgentProcess`
(`apps/web-server/src/features/agent-sessions/logic/agent-process.ts`) instead of
re-implementing "spawn → pipe stdout → tee → bump idle → cancel → recover answer".

List the current call sites when you need them — an enumeration in this file would
rot between edits:

```bash
grep -rlnE 'runAgentProcess|runReadOnlyAnswerAgent' apps/web-server/src --include='*.ts' | grep -v '\.test\.'
```

The primitive owns the shared core: spawn; pipe + tee stdout/stderr; bump the idle
clock on every chunk; `startIdleTimer` with the session-JSONL-growth backstop. The
claude agentic argv comes from `buildClaudeAgenticArgs`. Each caller passes only
its differences as params/closures: `onChunk` (sink), `captureStdout`, `stdin`
(codex `-`), `activityPath`, `onIdle`/`onTick`, and maps `handle.done` to its own
return shape + cancellation source (registry / `AbortSignal` / `children` set).

**Rule:** a new agent feature, or any change to spawn/idle/stream behaviour, goes
through `runAgentProcess` / `buildClaudeAgenticArgs` — never a fresh copy. If the
runner can't express a need, add a param to it.

## Rule

- Adding a spawn/tee/idle block → use (or extend) the shared runner; don't copy.
- Adding a claude argv → use the shared arg builder; don't re-list the flags.
- Adding a UI surface → `cl_ui-design-philosophy`. Background task → `cl_async-task-ux`.
- Writing the code itself → `cl_code-conventions` (comments, errors, types, tests,
  coverage). The mechanical half is `npm run check:conventions`, not reading.
- When the shared thing doesn't *quite* fit, **extend it with a parameter** — do
  not fork a copy. If extending would make it a god-function, split a small shared
  core with thin adapters (see the runner sketch above), still not copies.
