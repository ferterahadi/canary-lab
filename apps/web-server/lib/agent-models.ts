/**
 * Single source of truth for which model each agent-spawning feature runs on.
 *
 * Every Canary Lab feature that shells out to the Claude or Codex CLI is listed
 * here. `null` means AGENT DEFAULT: no `--model` flag is passed, so the CLI uses
 * its own configured default. To pin a feature to a specific model, set the
 * relevant string (e.g. `claude: 'haiku'`, `codex: 'gpt-5.4-mini'`) and the
 * spawn site splices `--model <id>` into its argv automatically.
 *
 * Today every entry is agent-default; the registry exists so a model can be
 * pinned per-feature later without hunting through spawn code. (The external
 * evaluation export is not here — it has no server-side spawn; the connecting
 * client authors it.)
 */
export type ModelAgentKind = 'claude' | 'codex'

export interface AgentModelChoice {
  /** Model id for the Claude CLI, or null for the CLI's default. */
  claude: string | null
  /** Model id for the Codex CLI, or null for the CLI's default. */
  codex: string | null
}

const AGENT_DEFAULT: AgentModelChoice = { claude: null, codex: null }

/** Coverage annotate pass — annotate-engine.ts. */
export const ANNOTATE_MODELS: AgentModelChoice = { ...AGENT_DEFAULT }

/** PRD summarization pass — coverage/prd-summary.ts. */
export const PRD_SUMMARY_MODELS: AgentModelChoice = { ...AGENT_DEFAULT }

/** Evaluation-export localized rewrite — test-review-export.ts. */
export const EVALUATION_REWRITE_MODELS: AgentModelChoice = { ...AGENT_DEFAULT }

/** Interactive heal / auto-repair REPL — runtime/auto-heal.ts. */
export const HEAL_MODELS: AgentModelChoice = { ...AGENT_DEFAULT }

/** Port-ification agent — runtime/portify/agent.ts. */
export const PORTIFY_MODELS: AgentModelChoice = { ...AGENT_DEFAULT }

/** Add-Test wizard, stage 1 (plan) — wizard-agent-runner.ts. */
export const WIZARD_PLAN_MODELS: AgentModelChoice = { ...AGENT_DEFAULT }

/** Add-Test wizard, stage 2 (spec) — wizard-agent-runner.ts. */
export const WIZARD_SPEC_MODELS: AgentModelChoice = { ...AGENT_DEFAULT }

/** The pinned model for an agent under a given choice, or null for agent default. */
export function modelFor(choice: AgentModelChoice, agent: ModelAgentKind): string | null {
  return agent === 'claude' ? choice.claude : choice.codex
}

/** `['--model', id]` when pinned, or `[]` for agent default — splice into argv. */
export function modelArgs(model: string | null): string[] {
  return model ? ['--model', model] : []
}
