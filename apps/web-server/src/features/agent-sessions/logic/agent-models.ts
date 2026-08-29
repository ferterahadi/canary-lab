import type { ModelAgentKind, StageModelChoice } from '../../../../../../shared/agent-models'

/**
 * Server side of the model cockpit: the argv builders every spawn site splices
 * in, plus the heal-stage env pin. The vocabulary itself (stage keys, effort
 * levels, curated models, recommendation tiers, normalization, resolution)
 * lives in shared/agent-models.ts — ONE home for the web UI and this server.
 *
 * A stage's choice resolves as: launch override (persisted on the
 * run/flight/job record at start — immutable mid-execution) → workspace config
 * (`agentModels` in canary-lab.config.json) → agent default (no flags, the
 * CLI's own configuration). The heal stage additionally honors the
 * `CANARY_LAB_HEAL_MODEL` env pin above all of those.
 */
export * from '../../../../../../shared/agent-models'

// ── Argv builders ────────────────────────────────────────────────────────────
/** `['--model', id]` when pinned, or `[]` for agent default — splice into argv. */
export function modelArgs(model: string | null): string[] {
  return model ? ['--model', model] : []
}

/** The per-CLI reasoning-effort argv. Codex has no dedicated flag; its knob is
 *  a config override on the exec command line. */
export function effortArgs(agent: ModelAgentKind, effort: string | null): string[] {
  if (!effort) return []
  return agent === 'claude' ? ['--effort', effort] : ['-c', `model_reasoning_effort=${effort}`]
}

/** Full model+effort argv for one spawned stage. */
export function agentModelArgs(agent: ModelAgentKind, choice: StageModelChoice): string[] {
  return [...modelArgs(choice.model), ...effortArgs(agent, choice.effort)]
}

// ── Heal env pin ─────────────────────────────────────────────────────────────
export interface AgentModelChoice {
  /** Model id for the Claude CLI, or null for the CLI's default. */
  claude: string | null
  /** Model id for the Codex CLI, or null for the CLI's default. */
  codex: string | null
}

/**
 * Interactive heal / auto-repair REPL — runtime/auto-heal.ts.
 *
 * `CANARY_LAB_HEAL_MODEL` pins the repair agent for one server, read once at
 * boot, and wins over both the launch plan and workspace config. The default
 * stays agent-default deliberately: repair is the product, and a weaker model
 * there is a worse product for everyone.
 *
 * What it is for is demonstrating the loop. On the strongest model the repair
 * agent reads the whole service and fixes every defect in a single pass — a
 * good outcome that shows none of the try / rerun / try again the loop exists
 * for. A smaller model needs the cycles it was built for. Both agents take the
 * same value; only one of them runs a given repair.
 */
export const HEAL_MODELS: AgentModelChoice = healModelsFromEnv()

export function healModelsFromEnv(env: NodeJS.ProcessEnv = process.env): AgentModelChoice {
  const pinned = env.CANARY_LAB_HEAL_MODEL?.trim()
  return pinned ? { claude: pinned, codex: pinned } : { claude: null, codex: null }
}
