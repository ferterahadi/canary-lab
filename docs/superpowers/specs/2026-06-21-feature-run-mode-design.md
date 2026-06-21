# Feature Run-Mode Standardization — Design

Date: 2026-06-21
Status: Approved (design); pending implementation plan
Scope: `apps/web-server` — run-mode features (draft/wizard, portify, evaluation
export, coverage) + heal (Layer 1 only)

## Problem

Most Canary Lab features support two execution modes:

- **Internal** — the web-server spawns its own agent (PTY/CLI child) and drives
  the work.
- **External** — the user's own Claude/Codex client drives the work via MCP
  tools; the web-server acts as broker/store.

The mechanical spawn layer is already consolidated (`runAgentProcess` /
`buildClaudeAgenticArgs`). Everything *above* it is duplicated and inconsistent:

- The external-session metadata block is copy-pasted across `draft-store`,
  `evaluation-export-store`, and portify `types.ts`.
- The "internal vs external" discriminator is named three different ways with
  inconsistent values: `source` (`'internal'|'external'`, draft),
  `producer` (`'internal'|'external'`, eval; `'local'|'external'`, portify),
  `healMode` (`'auto'|'manual'|'external'`, runs).
- The external session URL field is `externalSessionUrl` (draft/eval) vs
  `sessionUrl` (portify).
- The `ClientKind` union (`'claude-cli'|'claude-desktop'|'codex-cli'|
  'codex-desktop'|'other'`) is redeclared 3×.
- `atomicWrite` (tmp + rename) is copy-pasted 4× (portify, coverage, benchmark,
  manifest).
- Two **different** file-backed store idioms exist:
  - **Family A** — class + index + `changed`/`removed` events +
    `reconcileInterrupted` (`PortifyRunStore`, `CoverageJobRunStore`,
    `BenchmarkRunStore`; their comments literally say "Mirrors
    PortifyRunStore" / "Mirrors BenchmarkRunStore").
  - **Family B** — free functions + per-record dir + `transition()` state-machine
    guard, no events (`draft-store`, `evaluation-export-store`).

Result: the same bug must be fixed N times, and a new feature has no single
pattern to copy.

## Objectives

1. A new feature's run-mode implementation is similar by construction (one
   pattern to follow).
2. Improving the implementation once benefits all features (one home per
   concern).

## Non-goals

- Replacing `runAgentProcess` / `buildClaudeAgenticArgs` (already shared).
- Forcing heal's claim→signal lifecycle into the produce→submit contract.
- Back-compat for on-disk records (clean break — `~/.canary-lab` is ephemeral
  run-history).
- Making every feature support both modes (coverage may stay internal-only; the
  goal is to make adding the external mode trivial, not mandatory).

## Architecture — three composable layers

Inheritance is rejected (god-base-class risk; see `cl_reuse-shared-logic`). The
design is three layers a feature composes; dependencies point downward only.

```
Layer 3  FeatureRunMode<TStart, TRecord, TArtifact>   ← contract (produce→submit)
           implemented by: draft, portify, evaluation, coverage
Layer 2  FileBackedTaskStore<T>                        ← persistence helper
           used by: draft, portify, evaluation, coverage, benchmark
Layer 1  shared types (ClientKind, RunProducer, ExternalSessionMeta, atomicWrite)
           used by: all of the above + heal
```

A feature may use Layer 1, 1+2, or 1+2+3. Heal uses **Layer 1 only**.

## Layer 1 — shared types (clean break)

New shared module (proposed: `apps/web-server/src/features/shared/run-mode/` or
existing shared dir — finalize during planning):

```ts
type ClientKind = 'claude-cli' | 'claude-desktop' | 'codex-cli' | 'codex-desktop' | 'other'
type RunProducer = 'internal' | 'external'
interface ExternalSessionMeta {
  clientKind: ClientKind
  sessionId: string
  conversationName?: string
  sessionUrl?: string
}
```

Replacements:

| New | Replaces |
| --- | --- |
| `ClientKind` | `ExternalHealClientKind`, `PortifyClientKind`, draft/eval inline copies |
| `RunProducer` | `DraftSource`, `EvaluationExportProducer`, `PortifyProducer` (`'local'`→`'internal'`) |
| `ExternalSessionMeta` | external block in draft/eval/portify; `externalSessionUrl`→`sessionUrl` |
| shared `atomicWrite` | 4 copies (portify, coverage, benchmark, manifest) |

`ExternalHealSession` becomes `ExternalSessionMeta` **+ liveness**
(`claimedAt`, `lastHeartbeatAt`, `status`, `cycleCount`, `clientVersion?`) — heal
extends the shared core, does not redeclare it.

**Clean break:** readers expect `producer`. Old on-disk records carrying
`source` / `local` / no field normalize to `producer: 'internal'`. No migration
shim. `healMode` is unchanged (separate 3-value concept, see Layer 3 notes).

## Layer 2 — `FileBackedTaskStore<T>` (Option A, maximum unification)

Decision: **Option A — generic class**, event-first, with the full capability
set turned on for every store. The only per-feature variation is the config
object passed to the constructor.

```ts
interface TaskStoreConfig<T> {
  logsDir: string
  dirName: string                                 // 'drafts' | 'portify' | 'evaluation-exports' | ...
  idOf: (rec: T) => string
  indexEntryOf: (rec: T) => Record<string, unknown>   // projection into the index row
  validate?: (raw: unknown) => T | null
  allowedTransitions?: Record<string, string[]>       // state-machine guard
  isTerminal?: (rec: T) => boolean                    // for reconcileInterrupted
}

class FileBackedTaskStore<T> {
  constructor(config: TaskStoreConfig<T>)
  save(rec: T): void                  // atomicWrite manifest + upsert index + emit 'changed'
  get(id: string): T | null
  patch(id: string, patch: Partial<T>): T | null
  transition(id: string, to: string, patch?: Partial<T>): T   // throws IllegalTransition
  list(): IndexEntry[]
  remove(id: string): void            // rm dir + drop index entry + emit 'removed'
  reconcileInterrupted(now: () => string): void
  onEvent(fn: (e: TaskStoreEvent) => void): void
  offEvent(fn: (e: TaskStoreEvent) => void): void
}

interface TaskStoreEvent { kind: 'changed' | 'removed'; id?: string }
```

### Maximum unification: every store gets the full set

| Capability | Today | After |
| --- | --- | --- |
| Class idiom | 3 of 5 | all 5 |
| Index file | 3 of 5 | all 5 (draft/eval gain it; drop dir-scan) |
| `changed`/`removed` events | 3 of 5 | all 5 (draft/eval gain live WS push — wanted by `cl_ws-driven-state`) |
| `reconcileInterrupted` | 3 of 5 | all 5 |
| Declared state machine | 1 of 5 | all 5 (portify/coverage/eval states formalized) |
| `atomicWrite` | 4 copies | 1 shared |

After migration the only difference between features is the config object:

```ts
new FileBackedTaskStore<DraftRecord>({
  logsDir,
  dirName: 'drafts',
  idOf: r => r.draftId,
  indexEntryOf: r => ({ draftId: r.draftId, status: r.status, featureName: r.featureName }),
  allowedTransitions: DRAFT_TRANSITIONS,
  isTerminal: r => ['accepted', 'rejected', 'cancelled', 'error'].includes(r.status),
  validate: validateDraftRecord,
})
```

### Per-store current state (the inconsistency being removed)

| Store | index | events | transition guard | reconcileInterrupted |
| --- | --- | --- | --- | --- |
| portify | yes | yes | no | yes |
| coverage job | yes | yes | no | yes |
| benchmark | yes | yes | no | yes |
| draft | no (dir-scan) | no | yes (9-state) | no |
| evaluation export | no (dir-scan) | no | no (free patch) | partial |

### Option B (recorded, rejected)

Functional factory `createTaskStore<T>(config)` returning a closure bag with the
same surface. Rejected: 3 of 5 stores are already classes (least churn); a class
instance is the natural owner of the listener `Set` + `logsDir`; `cl_async-task-ux`
frames these as stateful background-task stores. Option B's only edge — matching
draft/eval's free-function style — evaporates since those two migrate regardless.

## Layer 3 — `FeatureRunMode` contract

A documented interface (naming + shape convention) plus one shared
internal-producer runner. Not a base class features are called through — their
agent prompts and artifact shapes genuinely differ.

```ts
interface FeatureRunMode<TStart, TRecord, TArtifact> {
  readonly store: FileBackedTaskStore<TRecord>
  startInternal(input: TStart): Promise<TRecord>                  // create record + spawn agent
  startExternal(input: TStart & ExternalSessionMeta): TRecord     // create 'waiting' record
  submitExternal(id: string, artifact: TArtifact): TRecord        // user's client pushes result
  finalize(id: string, artifact: TArtifact): TRecord             // shared persist + transition
}
```

### Shared internal-producer runner

Today every internal path repeats: spawn via `runAgentProcess` → tee/stream →
pin `sessionRef` for live `AgentSessionView` → on-done capture artifact →
`finalize`; on idle/error → transition to error. One helper owns it:

```ts
runInternalProducer({
  store, recordId,
  buildArgs,     // feature-specific agent argv/prompt
  onArtifact,    // feature-specific: extract artifact from agent output
})
```

Each feature supplies only its differences (`buildArgs`, `onArtifact`). The
external path is thinner — `startExternal` + `submitExternal` over the store,
with `ExternalSessionMeta` from the claiming client.

### Explicitly out of the contract

- `healMode` (`'auto'|'manual'|'external'`) stays a separate concept on the run
  manifest. Heal is the bespoke `ExternalHealBroker` (claim→signal), untouched.
  Only `RunProducer` (2-value) is unified.

## Heal — Layer 1 only

`ExternalHealBroker` keeps its in-memory `Map` mirrored into `RunManifest` and
its claim/release/heartbeat/handoff/stale-sweep lifecycle. It adopts only the
shared types: `ClientKind` and `ExternalHealSession extends ExternalSessionMeta`.
No lifecycle change → no `cl_sync-agent-surfaces` trigger.

## Migration order (bottom-up, each step shippable & green)

1. **Layer 1 types** — add `ClientKind`, `RunProducer`, `ExternalSessionMeta`,
   shared `atomicWrite`; rename fields (`source`/`local`→`producer`,
   `externalSessionUrl`→`sessionUrl`); clean break, no shim.
2. **Layer 2 store** — build `FileBackedTaskStore`. Migrate the 3 class stores
   first (portify/coverage/benchmark — near-identical, lowest risk), then draft +
   evaluation (they gain index + events + formal state machine).
3. **Layer 3 contract** — add interface + `runInternalProducer`; route
   draft/portify/evaluation/coverage internal paths through it.
4. **Heal** — adopt Layer 1 types only (`ExternalHealSession extends
   ExternalSessionMeta`).

## Testing

- Existing store tests (`draft-store.test`, `evaluation-export-store`, portify /
  coverage via routes) are the safety net — keep green at every step.
- New generic `FileBackedTaskStore` unit tests: save/index/events/transition
  (legal + illegal)/reconcile/remove.
- `runInternalProducer` unit test with a fake spawn (success, idle, error).
- Per step: full `npx vitest run` + `tsc -p tsconfig.build.json --noEmit`.
- MCP smoke test: unaffected (no tools added/removed) — no `cl_add-mcp-tool`.
- `cl_sync-agent-surfaces`: not triggered (run-loop/heal semantics unchanged).
- `cl_ws-driven-state`: draft/eval gain live events — confirm their UIs react
  without refresh after migration.

## Open items for the implementation plan

- Final home for the Layer 1 shared module (new `features/shared/run-mode/` vs an
  existing shared dir).
- Exact `allowedTransitions` maps for portify, coverage, evaluation (draft's
  9-state machine already exists).
- Whether `IndexEntry` is generic (`Record<string, unknown>`) or a small typed
  base (`{ id; status; ... }`) — settle during planning.
