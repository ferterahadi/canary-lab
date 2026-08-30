/**
 * Model-cockpit vocabulary: which model + reasoning effort each internal
 * agent-spawning stage runs on. ONE home for both sides — the web settings
 * matrix and launch gate render these, and the server resolves every spawn
 * through them. External-agent work is out of scope by design: it runs on the
 * client's own model setup, and no server-side process exists there.
 *
 * Effort maps to each CLI's own knob — verified live against claude 2.1.250
 * (`--effort low|medium|high|xhigh|max`) and codex 0.149.0
 * (`-c model_reasoning_effort=minimal|low|medium|high|xhigh`). The dropdown
 * fallback is curated data; any custom id is passed to `--model` verbatim.
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

export interface KnownModelOption {
  /** The exact value passed to the agent CLI. */
  value: string
  /** Display copy may explain alias behavior without changing that value. */
  label: string
}

/** Curated fallback options for the model dropdowns. Claude documents these as
 *  aliases for its latest model; say so in the label instead of presenting an
 *  unversioned family name as though it were pinned. Codex options come from
 *  its installed CLI at runtime, so its fallback remains Agent default +
 *  Custom id when discovery is unavailable. */
export const KNOWN_MODEL_OPTIONS: Record<ModelAgentKind, readonly KnownModelOption[]> = {
  claude: [
    { value: 'fable', label: 'Fable (latest)' },
    { value: 'opus', label: 'Opus (latest)' },
    { value: 'sonnet', label: 'Sonnet (latest)' },
    { value: 'haiku', label: 'Haiku (latest)' },
  ],
  codex: [],
}

/** Values used for recognition and recommendation validation. Derived from the
 *  display catalog so label and CLI value cannot drift into separate lists. */
export const KNOWN_MODELS: Record<ModelAgentKind, readonly string[]> = {
  claude: KNOWN_MODEL_OPTIONS.claude.map(({ value }) => value),
  codex: [],
}

// ── Recommendation policy ────────────────────────────────────────────────────
// The tier is explanatory UI copy; the actual provider knobs are explicit per
// stage below because equal-capability models can need different effort levels.
// Claude's stable aliases resolve to the latest family member. Codex resolves a
// Sol/Terra role from the installed CLI catalog, so version releases do not
// require a Canary update.
export type ModelTier = 'frontier' | 'agentic' | 'balanced'

export const STAGE_TIERS: Record<ModelStageKey, ModelTier> = {
  scout: 'balanced',
  docs: 'balanced',
  prd: 'agentic',
  gen: 'frontier',
  mapping: 'agentic',
  heal: 'frontier',
  portify: 'balanced',
  report: 'balanced',
  commit: 'balanced',
}

/** Why a stage gets its tier. These are the failure-cost inputs to the policy,
 *  not claims that a model was benchmarked on Canary's workload. */
export const STAGE_RECOMMENDATION_REASON: Record<ModelStageKey, string> = {
  scout: 'Repository analysis writes the configuration every later stage depends on.',
  docs: 'Document collection is bounded and read-only, but must retain relevant requirements.',
  prd: 'The requirements summary becomes the stable source of truth for coverage.',
  gen: 'Test authoring turns coverage gaps into executable verification code.',
  mapping: 'Semantic mapping must avoid both missed tests and false coverage claims.',
  heal: 'Auto-repair edits application code, so correctness matters more than latency.',
  portify: 'Parallel setup rewrites cross-service port wiring and concurrency behavior.',
  report: 'The report turns run evidence into user-facing conclusions and must preserve the verdict.',
  commit: 'Commit and PR copy needs faithful diff analysis but does not modify product code.',
}

/** Provider-specific knobs per stage. Codex models stay null here because their
 *  versioned ids are resolved from the runtime catalog below. */
export const RECOMMENDED_BY_STAGE: Record<ModelAgentKind, Record<ModelStageKey, StageModelChoice>> = {
  claude: {
    scout: { model: 'sonnet', effort: 'high' },
    docs: { model: 'sonnet', effort: 'medium' },
    prd: { model: 'opus', effort: 'high' },
    gen: { model: 'opus', effort: 'max' },
    mapping: { model: 'opus', effort: 'high' },
    heal: { model: 'opus', effort: 'max' },
    portify: { model: 'sonnet', effort: 'high' },
    report: { model: 'sonnet', effort: 'high' },
    commit: { model: 'sonnet', effort: 'medium' },
  },
  codex: {
    scout: { model: null, effort: 'high' },
    docs: { model: null, effort: 'medium' },
    prd: { model: null, effort: 'high' },
    gen: { model: null, effort: 'high' },
    mapping: { model: null, effort: 'medium' },
    heal: { model: null, effort: 'high' },
    portify: { model: null, effort: 'high' },
    report: { model: null, effort: 'high' },
    commit: { model: null, effort: 'medium' },
  },
}

const CODEX_MODEL_ROLE_BY_STAGE: Record<ModelStageKey, 'sol' | 'terra'> = {
  scout: 'terra',
  docs: 'terra',
  prd: 'sol',
  gen: 'sol',
  mapping: 'sol',
  heal: 'sol',
  portify: 'terra',
  report: 'terra',
  commit: 'terra',
}

export function recommendedChoice(
  agent: ModelAgentKind,
  stage: ModelStageKey,
  availableModels: readonly KnownModelOption[] = KNOWN_MODEL_OPTIONS[agent],
): StageModelChoice {
  const base = RECOMMENDED_BY_STAGE[agent][stage]
  if (agent === 'claude') return base

  // The Sol/Terra role names are stable while the version prefix changes.
  // If a future catalog no longer exposes that role, keep the safe effort-only
  // recommendation rather than pinning an unrelated model by list position.
  const suffix = `-${CODEX_MODEL_ROLE_BY_STAGE[stage]}`
  const model = availableModels.find(({ value }) => value.toLowerCase().endsWith(suffix))?.value ?? null
  return { ...base, model }
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
