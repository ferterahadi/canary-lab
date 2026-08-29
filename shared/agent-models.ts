/**
 * Model-cockpit vocabulary: which model + reasoning effort each internal
 * agent-spawning stage runs on. ONE home for both sides — the web settings
 * matrix and launch gate render these, and the server resolves every spawn
 * through them. External-agent work is out of scope by design: it runs on the
 * client's own model setup, and no server-side process exists there.
 *
 * Effort maps to each CLI's own knob — verified live against claude 2.1.250
 * (`--effort low|medium|high|xhigh|max`) and codex 0.149.0
 * (`-c model_reasoning_effort=minimal|low|medium|high|xhigh`). Neither CLI can
 * enumerate its models headlessly, so KNOWN_MODELS is curated last-known data
 * (any custom id string is accepted and passed to `--model` verbatim).
 */
export type ModelAgentKind = 'claude' | 'codex'

// ── Stage vocabulary ─────────────────────────────────────────────────────────
// One key per user-facing agent spawn. Flight pipeline stages first, then the
// standalone utilities. `gen` is the specs-authoring pass of specs-coverage;
// `mapping` is its annotate pass (they spawn separately and deserve separate
// knobs — authoring writes code, mapping only reads).
export const MODEL_STAGE_KEYS = [
  'scout',
  'docs',
  'prd',
  'gen',
  'mapping',
  'heal',
  'portify',
  'report',
  'commit',
] as const

export type ModelStageKey = (typeof MODEL_STAGE_KEYS)[number]

/** Stage key → what the spawn does for the user (outcome, not implementation).
 *  Same register as FLIGHT_STAGE_LABEL: sentence case, display copy only —
 *  the KEYS stay canonical in config/records. */
export const MODEL_STAGE_LABEL: Record<ModelStageKey, string> = {
  scout: 'Repo scan',
  docs: 'Doc collection',
  prd: 'Requirements summary',
  gen: 'Test authoring',
  mapping: 'Coverage mapping',
  heal: 'Auto-repair',
  portify: 'Parallel setup',
  report: 'Report',
  commit: 'Commit message',
}

/** One stage's resolved knobs. `null` means agent default: no flag is passed
 *  and the CLI uses its own configuration. */
export interface StageModelChoice {
  model: string | null
  effort: string | null
}

export const AGENT_DEFAULT_CHOICE: StageModelChoice = Object.freeze({ model: null, effort: null })

/** Per-agent stage plans as stored in config or carried by a launch override.
 *  An absent stage means agent default. */
export type AgentStagePlans = Partial<Record<ModelStageKey, StageModelChoice>>

export interface AgentModelsConfig {
  claude: AgentStagePlans
  codex: AgentStagePlans
}

export const EMPTY_AGENT_MODELS: AgentModelsConfig = Object.freeze({ claude: {}, codex: {} })

// ── Effort + model vocab per CLI ─────────────────────────────────────────────
export const EFFORT_LEVELS = {
  claude: ['low', 'medium', 'high', 'xhigh', 'max'],
  codex: ['minimal', 'low', 'medium', 'high', 'xhigh'],
} as const satisfies Record<ModelAgentKind, readonly string[]>

/** Curated last-known model options per CLI, for the settings dropdowns.
 *  claude aliases are documented by `claude --help`; codex publishes no stable
 *  alias list, so its dropdown is agent-default + custom id only. Data, not
 *  behavior: a custom id always passes through verbatim. */
export const KNOWN_MODELS: Record<ModelAgentKind, readonly string[]> = {
  claude: ['fable', 'opus', 'sonnet', 'haiku'],
  codex: [],
}

// ── Recommendation policy ────────────────────────────────────────────────────
// Stages ship a *tier*, not a model id, so recommendations survive model
// releases: the UI resolves the tier against whatever models exist at render
// time. Repair-adjacent stages recommend the strongest model — repair is the
// product, and a weaker model there is a worse product for everyone.
export type ModelTier = 'strongest' | 'balanced' | 'fastest'

export const STAGE_TIERS: Record<ModelStageKey, ModelTier> = {
  scout: 'balanced',
  docs: 'balanced',
  prd: 'balanced',
  gen: 'strongest',
  mapping: 'balanced',
  heal: 'strongest',
  portify: 'strongest',
  report: 'fastest',
  commit: 'fastest',
}

/** What each tier resolves to today. Codex recommends effort only (its model
 *  ids aren't stable enough to curate); claude recommends documented aliases. */
export const RECOMMENDED_BY_TIER: Record<ModelAgentKind, Record<ModelTier, StageModelChoice>> = {
  claude: {
    strongest: { model: 'opus', effort: 'high' },
    balanced: { model: 'sonnet', effort: 'medium' },
    fastest: { model: 'haiku', effort: 'low' },
  },
  codex: {
    strongest: { model: null, effort: 'xhigh' },
    balanced: { model: null, effort: 'medium' },
    fastest: { model: null, effort: 'low' },
  },
}

export function recommendedChoice(agent: ModelAgentKind, stage: ModelStageKey): StageModelChoice {
  return RECOMMENDED_BY_TIER[agent][STAGE_TIERS[stage]]
}

// ── Normalization (the JSON/config boundary) ─────────────────────────────────
function isModelStageKey(v: string): v is ModelStageKey {
  return (MODEL_STAGE_KEYS as readonly string[]).includes(v)
}

/** A usable stage choice out of untrusted JSON, or undefined when the entry
 *  carries nothing (both knobs agent-default) — absent beats `{null, null}` so
 *  stored config only lists real deviations. */
export function normalizeStageChoice(agent: ModelAgentKind, v: unknown): StageModelChoice | undefined {
  if (typeof v !== 'object' || v === null) return undefined
  const raw = v as { model?: unknown; effort?: unknown }
  const model = typeof raw.model === 'string' && raw.model.trim() ? raw.model.trim() : null
  const effort =
    typeof raw.effort === 'string' && (EFFORT_LEVELS[agent] as readonly string[]).includes(raw.effort)
      ? raw.effort
      : null
  if (model === null && effort === null) return undefined
  return { model, effort }
}

/** One agent's stage plan out of untrusted JSON — the launch-gate override
 *  payloads carry a single agent's plan, where config carries both. */
export function normalizeStagePlans(agent: ModelAgentKind, v: unknown): AgentStagePlans {
  if (typeof v !== 'object' || v === null) return {}
  const plans: AgentStagePlans = {}
  for (const [key, value] of Object.entries(v)) {
    if (!isModelStageKey(key)) continue
    const choice = normalizeStageChoice(agent, value)
    if (choice) plans[key] = choice
  }
  return plans
}

export function normalizeAgentModels(v: unknown): AgentModelsConfig {
  if (typeof v !== 'object' || v === null) return { claude: {}, codex: {} }
  const raw = v as { claude?: unknown; codex?: unknown }
  return {
    claude: normalizeStagePlans('claude', raw.claude),
    codex: normalizeStagePlans('codex', raw.codex),
  }
}

// ── Record-surface display ──────────────────────────────────────────────────
/** The pinned entries of a stage plan as display strings ("Heal opus · high"),
 *  in stage order — empty when every stage rides the agent default. */
export function pinnedPlanEntries(plans: AgentStagePlans | undefined): string[] {
  const out: string[] = []
  for (const stage of MODEL_STAGE_KEYS) {
    const c = plans?.[stage]
    if (!c || (c.model === null && c.effort === null)) continue
    const knobs = [c.model, c.effort].filter((v): v is string => v !== null).join(' · ')
    out.push(`${MODEL_STAGE_LABEL[stage]} ${knobs}`)
  }
  return out
}

/** One line for a record surface (run/flight/coverage detail): the stage
 *  choices this record locked at launch, or null when everything rides the
 *  agent default — record surfaces show nothing then, because the default is
 *  the norm rather than a fact worth a row. */
export function pinnedPlanSummary(plans: AgentStagePlans | undefined): string | null {
  const parts = pinnedPlanEntries(plans)
  return parts.length > 0 ? parts.join(' · ') : null
}

// ── Resolution ───────────────────────────────────────────────────────────────
/** The choice a launch should run a stage on: override (already resolved and
 *  persisted on the record) → workspace config → agent default. */
export function resolveStageChoice(
  agent: ModelAgentKind,
  config: AgentModelsConfig | undefined,
  stage: ModelStageKey,
  override?: StageModelChoice | null,
): StageModelChoice {
  if (override) return override
  return config?.[agent]?.[stage] ?? AGENT_DEFAULT_CHOICE
}

/** Per-agent choices for one stage — the shape handed to passes that pick
 *  their CLI at spawn time (or fall back across CLIs mid-chain), so whichever
 *  agent actually spawns runs with its own agent's choice. */
export type PerAgentStageChoices = Partial<Record<ModelAgentKind, StageModelChoice>>

/** One stage's choice resolved for BOTH agents — for the passes that pick
 *  their CLI by availability at spawn time (commit message, evaluation
 *  rewrite), so whichever they land on runs with its own agent's choice. */
export function perAgentStageChoices(
  config: AgentModelsConfig | undefined,
  stage: ModelStageKey,
): Record<ModelAgentKind, StageModelChoice> {
  return {
    claude: resolveStageChoice('claude', config, stage, null),
    codex: resolveStageChoice('codex', config, stage, null),
  }
}

/** A per-agent map out of untrusted JSON (a forwarded flight plan riding a
 *  route payload) — each entry validated against its OWN agent's vocabulary,
 *  entries carrying nothing dropped. */
export function normalizePerAgentChoices(v: unknown): PerAgentStageChoices {
  if (typeof v !== 'object' || v === null) return {}
  const raw = v as Record<string, unknown>
  const out: PerAgentStageChoices = {}
  for (const agent of ['claude', 'codex'] as const) {
    const choice = normalizeStageChoice(agent, raw[agent])
    if (choice) out[agent] = choice
  }
  return out
}
