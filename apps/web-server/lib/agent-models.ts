import type { HealAgent } from './runtime/auto-heal'

/**
 * Centralized model selection for the short-lived "structuring / wording" agent
 * passes — coverage annotate (annotate-engine.ts), PRD summary (prd-summary.ts),
 * and evaluation-export localized rewrite (test-review-export.ts). Each spawns a
 * one-shot Claude/Codex CLI process.
 *
 * `null` means AGENT DEFAULT: no `--model` flag is passed, so the CLI uses its
 * own configured default model. To re-pin a feature to a specific model, set the
 * relevant string here (e.g. `claude: 'haiku'`, `codex: 'gpt-5.4-mini'`) — this
 * is the single source of truth for these passes.
 *
 * The interactive heal loop, portify, and wizard stages already run on the
 * agent's default model (they never pass `--model`) and are not configured here.
 */
export interface AgentModelChoice {
  /** Model id for the Claude CLI, or null for the CLI's default. */
  claude: string | null
  /** Model id for the Codex CLI, or null for the CLI's default. */
  codex: string | null
}

/** Coverage annotate pass — see annotate-engine.ts. */
export const ANNOTATE_MODELS: AgentModelChoice = { claude: null, codex: null }

/** PRD summarization pass — see coverage/prd-summary.ts. */
export const PRD_SUMMARY_MODELS: AgentModelChoice = { claude: null, codex: null }

/** Evaluation-export localized rewrite — see test-review-export.ts. */
export const EVALUATION_REWRITE_MODELS: AgentModelChoice = { claude: null, codex: null }

/** The pinned model for an agent under a given choice, or null for agent default. */
export function modelFor(choice: AgentModelChoice, agent: HealAgent): string | null {
  return agent === 'claude' ? choice.claude : choice.codex
}

/** `['--model', id]` when pinned, or `[]` for agent default — splice into argv. */
export function modelArgs(model: string | null): string[] {
  return model ? ['--model', model] : []
}
