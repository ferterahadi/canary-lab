import { useEffect, useMemo, useState } from 'react'
import * as api from '@/shared/api/client'
import type { AgentModelsConfig, AgentProbeSnapshot, AgentStagePlans, ModelAgentKind, ModelStageKey, StageModelChoice } from '@/shared/api/client'
import {
  AGENT_DEFAULT_CHOICE,
  EFFORT_LEVELS,
  KNOWN_MODELS,
  MODEL_STAGE_KEYS,
  MODEL_STAGE_LABEL,
  STAGE_TIERS,
  recommendedChoice,
} from '@shared/agent-models'
import { Modal } from '@/shared/ui/atoms'
import { agentTitle } from './settings-options'

// The per-agent model matrix (2.2.0 model cockpit): one row per internal-agent
// stage, each with a model + reasoning-effort select. Stacked over Project
// Settings and routed as its `models` qualifier, so a refresh keeps it open.
// Saves ONLY the `agentModels` block (the PUT field-merges server-side), so an
// unsaved Settings draft behind it is never clobbered.

interface Props {
  agent: ModelAgentKind
  /** The whole saved block — Save rewrites this agent's plans inside it, so the
   *  other agent's plans survive the round-trip (the PUT replaces the block). */
  agentModels: AgentModelsConfig
  onClose: () => void
  /** Fired with the server's response after a successful save — the settings
   *  dialog behind updates its summary lines from it. */
  onSaved: (config: api.ProjectConfig) => void
}

/** The select sentinel for "a model id the curated list doesn't know" — picking
 *  it reveals the free-text id input (the escape hatch for new releases). */
const CUSTOM = '__custom'

function sameChoice(a: StageModelChoice, b: StageModelChoice): boolean {
  return a.model === b.model && a.effort === b.effort
}

/** Effective choice for a row — an absent plan is agent default. */
function rowChoice(plans: AgentStagePlans, stage: ModelStageKey): StageModelChoice {
  return plans[stage] ?? AGENT_DEFAULT_CHOICE
}

/** Row status: matches the shipped recommendation (✦), sits on agent default
 *  (quiet), or deviates (custom — amber chip + reset). */
function rowState(agent: ModelAgentKind, stage: ModelStageKey, choice: StageModelChoice): 'recommended' | 'default' | 'custom' {
  if (sameChoice(choice, recommendedChoice(agent, stage))) return 'recommended'
  if (sameChoice(choice, AGENT_DEFAULT_CHOICE)) return 'default'
  return 'custom'
}

function ProbeStrip({ agent, probe, busy, onRetry }: {
  agent: ModelAgentKind
  probe: AgentProbeSnapshot | null
  busy: boolean
  onRetry: () => void
}) {
  const entry = probe?.[agent] ?? null
  const retry = (
    <button type="button" onClick={onRetry} disabled={busy} className="cl-button px-2 py-0.5 text-[11px]">
      {busy ? 'Probing…' : 'Retry probe'}
    </button>
  )
  // Still probing (or the request itself failed): stay quiet — the probe is
  // informational and must never block configuring.
  if (!entry) {
    return (
      <div className="flex items-center gap-2 text-[11px]" style={{ color: 'var(--text-muted)' }}>
        <span className="min-w-0 flex-1 truncate">{busy ? 'Checking the installed CLI…' : 'CLI check unavailable — settings still apply.'}</span>
        {!busy && retry}
      </div>
    )
  }
  if (entry.state === 'ok') {
    return (
      <div className="flex items-center gap-2 text-[11px]" style={{ color: 'var(--text-muted)' }}>
        <span aria-hidden="true" className="cl-status-dot" style={{ background: 'var(--success)' }} />
        <span className="min-w-0 flex-1 truncate" title={entry.binaryPath ?? undefined}>
          {agent} CLI found{entry.version ? ` — ${entry.version}` : ''}
        </span>
      </div>
    )
  }
  // auth / missing: a visible warning with the exact remedy, and nothing
  // disabled — agent default keeps every launch possible either way.
  return (
    <div
      data-testid="model-matrix-probe-warning"
      className="flex items-start gap-2 rounded-md px-2.5 py-2 text-[11px]"
      style={{
        color: 'var(--text-primary)',
        border: '1px solid color-mix(in srgb, var(--warning) 35%, transparent)',
        background: 'color-mix(in srgb, var(--warning) 8%, transparent)',
      }}
    >
      <span className="min-w-0 flex-1">
        {entry.state === 'missing' ? `The ${agent} CLI isn't on PATH.` : `The ${agent} CLI needs a sign-in.`}
        {entry.remedy ? ` ${entry.remedy}` : ''}
        {' '}Choices here still save and apply once the CLI works.
      </span>
      {retry}
    </div>
  )
}

/** The per-stage model+effort rows — the matrix body, reused by the launch
 *  gate's "customize" card with a scoped stage subset. Controlled: the caller
 *  owns the plans object. */
export function StageChoiceGrid({ agent, stages, plans, onChange }: {
  agent: ModelAgentKind
  stages: readonly ModelStageKey[]
  plans: AgentStagePlans
  onChange: (stage: ModelStageKey, choice: StageModelChoice) => void
}) {
  const efforts = EFFORT_LEVELS[agent]
  const knownModels = KNOWN_MODELS[agent]
  return (
    <div className="overflow-hidden rounded-lg" style={{ border: '1px solid var(--border-default)' }}>
      {/* Header band + one grid row per stage — label, model, effort, state. */}
      <div
        className="grid items-center gap-2 px-3 py-1.5 text-[10px] uppercase tracking-wider"
        style={{ gridTemplateColumns: 'minmax(0,1.3fr) minmax(0,1fr) minmax(0,1fr) 92px', color: 'var(--text-muted)', borderBottom: '1px solid var(--border-default)', background: 'color-mix(in srgb, var(--bg-selected) 45%, transparent)' }}
      >
        <span>Stage</span>
        <span>Model</span>
        <span>Reasoning effort</span>
        <span />
      </div>
      {stages.map((stage, index) => {
        const choice = rowChoice(plans, stage)
        const state = rowState(agent, stage, choice)
        const isCustomModel = choice.model !== null && !knownModels.includes(choice.model)
        return (
          <div
            key={stage}
            data-testid={`model-row-${stage}`}
            className={`grid items-center gap-2 px-3 py-2 ${index > 0 ? 'border-t' : ''}`}
            style={{ gridTemplateColumns: 'minmax(0,1.3fr) minmax(0,1fr) minmax(0,1fr) 92px', borderColor: 'var(--border-default)' }}
          >
            <span className="min-w-0">
              <span className="block truncate text-[12px] font-medium" style={{ color: 'var(--text-primary)' }}>
                {MODEL_STAGE_LABEL[stage]}
              </span>
            </span>
            <span className="flex min-w-0 flex-col gap-1">
              <select
                aria-label={`${MODEL_STAGE_LABEL[stage]} model`}
                className="cl-input w-full px-1.5 py-1 text-xs"
                value={isCustomModel ? CUSTOM : choice.model ?? ''}
                onChange={(e) => {
                  const v = e.target.value
                  // Picking Custom… keeps the current id when there is one
                  // (a known id becomes the editable seed) — never blanks a
                  // value the user typed.
                  onChange(stage, { ...choice, model: v === '' ? null : v === CUSTOM ? choice.model ?? '' : v })
                }}
              >
                <option value="">Agent default</option>
                {knownModels.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
                <option value={CUSTOM}>Custom id…</option>
              </select>
              {isCustomModel && (
                <input
                  aria-label={`${MODEL_STAGE_LABEL[stage]} custom model id`}
                  className="cl-input w-full px-1.5 py-1 text-xs"
                  placeholder="model id (passed to --model verbatim)"
                  value={choice.model ?? ''}
                  onChange={(e) => {
                    const v = e.target.value
                    // Emptying the id falls back to agent default rather
                    // than saving a blank pin.
                    onChange(stage, { ...choice, model: v.trim() ? v : null })
                  }}
                />
              )}
            </span>
            <select
              aria-label={`${MODEL_STAGE_LABEL[stage]} reasoning effort`}
              className="cl-input w-full px-1.5 py-1 text-xs"
              value={choice.effort ?? ''}
              onChange={(e) => onChange(stage, { ...choice, effort: e.target.value || null })}
            >
              <option value="">Agent default</option>
              {efforts.map((e) => (
                <option key={e} value={e}>{e}</option>
              ))}
            </select>
            <span className="flex items-center justify-end gap-1">
              {state === 'recommended' && (
                <span
                  className="rounded-md px-1.5 py-0.5 text-[10px] font-medium"
                  title={`The shipped recommendation for this stage (${STAGE_TIERS[stage]} tier).`}
                  style={{ color: 'var(--accent)', border: '1px solid color-mix(in srgb, var(--accent) 35%, transparent)' }}
                >
                  ✦ rec
                </span>
              )}
              {state === 'custom' && (
                <>
                  <span
                    className="rounded-md px-1.5 py-0.5 text-[10px] font-medium"
                    title="Deviates from the shipped recommendation."
                    style={{ color: 'var(--warning)', border: '1px solid color-mix(in srgb, var(--warning) 35%, transparent)' }}
                  >
                    custom
                  </span>
                  <button
                    type="button"
                    aria-label={`Reset ${MODEL_STAGE_LABEL[stage]} to recommended`}
                    title="Reset to recommended"
                    onClick={() => onChange(stage, recommendedChoice(agent, stage))}
                    className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md"
                    style={{ color: 'var(--text-muted)' }}
                  >
                    ↺
                  </button>
                </>
              )}
            </span>
          </div>
        )
      })}
    </div>
  )
}

export function ModelMatrixDialog({ agent, agentModels, onClose, onSaved }: Props) {
  const [plans, setPlans] = useState<AgentStagePlans>(() => ({ ...agentModels[agent] }))
  const [probe, setProbe] = useState<AgentProbeSnapshot | null>(null)
  const [probeBusy, setProbeBusy] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadProbe = (fresh: boolean): void => {
    setProbeBusy(true)
    api.getAgentProbe(fresh)
      .then(setProbe)
      // Probe failure warns, never blocks — the strip renders its quiet
      // fallback and the matrix stays fully editable.
      .catch(() => {})
      .finally(() => setProbeBusy(false))
  }
  // The probe is a read of the machine, keyed to nothing in props.
  useEffect(() => { loadProbe(false) }, [])

  const efforts = EFFORT_LEVELS[agent]
  const knownModels = KNOWN_MODELS[agent]

  const setRow = (stage: ModelStageKey, choice: StageModelChoice): void => {
    setPlans((prev) => {
      const next = { ...prev }
      // Agent default is the absence of a plan — pruning here keeps the saved
      // config listing only real deviations (mirrors normalizeStageChoice).
      if (sameChoice(choice, AGENT_DEFAULT_CHOICE)) delete next[stage]
      else next[stage] = choice
      return next
    })
  }

  const dirty = useMemo(() => {
    const saved = agentModels[agent]
    const stages = new Set<ModelStageKey>([...MODEL_STAGE_KEYS])
    for (const stage of stages) {
      if (!sameChoice(rowChoice(plans, stage), rowChoice(saved, stage))) return true
    }
    return false
  }, [plans, agentModels, agent])

  const onSave = async (): Promise<void> => {
    setSaving(true)
    setError(null)
    try {
      const next = await api.putProjectConfig({ agentModels: { ...agentModels, [agent]: plans } })
      onSaved(next)
      onClose()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={`Configure models — ${agentTitle(agent)}`}
      eyebrow="Project Settings"
      ariaLabel={`Configure models for ${agentTitle(agent)}`}
      testId="model-matrix-dialog"
      width={620}
      stableScrollGutter
      footer={
        <>
          <button
            type="button"
            onClick={() => setPlans(Object.fromEntries(MODEL_STAGE_KEYS.map((s) => [s, recommendedChoice(agent, s)])))}
            className="cl-button mr-auto px-3 py-1 text-xs"
          >
            Reset all to recommended
          </button>
          {error && <span className="text-xs" style={{ color: 'var(--danger)' }}>{error}</span>}
          <button type="button" onClick={onClose} className="cl-button px-3 py-1 text-xs">
            Cancel
          </button>
          <button
            type="button"
            onClick={() => { void onSave() }}
            disabled={!dirty || saving}
            data-testid="model-matrix-save"
            className="cl-button px-3 py-1 text-xs"
            style={{
              color: dirty ? 'var(--accent)' : 'var(--text-muted)',
              border: '1px solid',
              borderColor: dirty ? 'color-mix(in srgb, var(--accent) 40%, transparent)' : 'var(--border-default)',
              background: dirty ? 'color-mix(in srgb, var(--accent) 8%, transparent)' : 'transparent',
              opacity: saving ? 0.6 : 1,
            }}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-3 p-3">
        <ProbeStrip agent={agent} probe={probe} busy={probeBusy} onRetry={() => loadProbe(true)} />
        <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
          Model and reasoning effort per stage, for the agents Canary Lab spawns itself. Agent default passes no
          flags — the CLI runs on its own configuration. ✦ marks the shipped recommendation for the stage.
        </div>

        <StageChoiceGrid agent={agent} stages={MODEL_STAGE_KEYS} plans={plans} onChange={setRow} />
      </div>
    </Modal>
  )
}
