import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import * as api from '@/shared/api/client'
import type { ModelAgentKind, ProjectConfig } from '@/shared/api/client'
import { EMPTY_AGENT_MODELS } from '@shared/agent-models'
import { Modal, Section } from '@/shared/ui/atoms'
import { OPTION_ROW_CLASS, OPTION_ROW_SECTION_BODY, optionRowStyle } from '@/shared/ui/OptionRow'
import { FolderPicker } from './FolderPicker'
import { GitHubSection } from './GitHubSection'
import { ModelMatrixDialog } from './ModelMatrixDialog'
import { RestartPhase, RestartProgress, defaultRedirect } from './SettingsRestartProgress'
import {
  ASK_ON_LAUNCH_OPTIONS,
  DEFAULT_PORT,
  EDITOR_OPTIONS,
  HEAL_AGENT_OPTIONS,
  INTERNAL_AGENTS_ONLY_COPY,
  migrateLegacyHealAgent,
  stagePlanSummary,
} from './settings-options'

interface Props {
  onClose: () => void
  // Injected in tests; production polls the new origin then navigates the tab.
  onRedirect?: (url: string, onProgress?: (phase: RestartPhase, attempt: number) => void) => void
  /** The per-agent model matrix stacked over this dialog. Route-driven
   *  (`?dialog=settings&models=…`) when supplied — controlled by App. Omitted
   *  (e.g. in unit tests) → internal open-state, the FeaturesColumn hybrid. */
  modelsFor?: ModelAgentKind | null
  onModelsFor?: (agent: ModelAgentKind | null) => void
}

/** Section-level help: what a control does, hung under the control at the
 *  section's own left edge. Row-level description text lives inside its row,
 *  under that row's label — the two altitudes are the whole reason this dialog
 *  reads as columns instead of a ragged list. */
function Hint({ children }: { children: ReactNode }) {
  return <div className="mt-1.5 text-xs" style={{ color: 'var(--text-muted)' }}>{children}</div>
}

/** One settings choice, radio or checkbox.
 *
 *  Uses the app's shared option row — the same geometry, neutral surface and
 *  selected-grey as the flight pickers and the heal modes — so the radio groups
 *  and the standalone checkboxes here can't drift apart from each other or from
 *  the rest of the app. Hover is `.cl-hover-row` (background only). It used to
 *  be `.cl-card-hover`, which is the CARD primitive: it added a popover-scale
 *  drop shadow and a stronger border, so moving the pointer down a flat list
 *  lifted whichever item it happened to be over off the dialog.
 *
 *  The native input stays the mark: it carries the keyboard and screen-reader
 *  behaviour of a real radio group for free, tinted to the app's accent the way
 *  the cleanup pages tint theirs. */
function ChoiceRow({ type, name, value, checked, onChange, label, description, testId, divider }: {
  type: 'radio' | 'checkbox'
  name?: string
  value?: string
  checked: boolean
  onChange: (checked: boolean) => void
  label: string
  description: string
  testId?: string
  /** Hairline above the row — set on every row but the first, so a group reads
   *  as one connected list. */
  divider?: boolean
}) {
  return (
    <label
      // Hover is gated on the resting state: the picked row's inline
      // selected-grey outranks the hover class anyway, so asking for both said
      // one thing twice.
      className={`${OPTION_ROW_CLASS} ${checked ? '' : 'cl-hover-row'} ${divider ? 'border-t' : ''}`}
      style={optionRowStyle({ selected: checked, interactive: true })}
    >
      <input
        type={type}
        {...(name ? { name } : {})}
        {...(value ? { value } : {})}
        {...(testId ? { 'data-testid': testId } : {})}
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        // Sits on the label's line rather than the top of the paragraph, and in
        // a 13px box — the same width the GitHub row's status dot reserves, so
        // both label columns start on the same pixel.
        className="mt-0.5 h-[13px] w-[13px] shrink-0"
        style={{ accentColor: 'var(--accent)' }}
      />
      <span className="min-w-0 flex-1">
        {/* Option rows across the app are 12.5/medium over a 12px muted
            description — `text-sm` here matched the dialog title and left label
            and description a hair apart. */}
        <span className="block text-[12.5px] font-medium" style={{ color: 'var(--text-primary)' }}>{label}</span>
        <span className="mt-0.5 block text-xs" style={{ color: 'var(--text-muted)' }}>{description}</span>
      </span>
    </label>
  )
}

export function SettingsModal({ onClose, onRedirect, modelsFor, onModelsFor }: Props) {
  const [config, setConfig] = useState<ProjectConfig | null>(null)
  const [draft, setDraft] = useState<ProjectConfig | null>(null)
  // Controlled when App routes it; uncontrolled otherwise (unit tests).
  const [modelsForInternal, setModelsForInternal] = useState<ModelAgentKind | null>(null)
  const matrixAgent = modelsFor !== undefined ? modelsFor : modelsForInternal
  const setMatrixAgent = onModelsFor ?? setModelsForInternal
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [portInput, setPortInput] = useState('')
  const [portBusy, setPortBusy] = useState(false)
  const [portError, setPortError] = useState<string | null>(null)
  const [pendingConfirm, setPendingConfirm] = useState<number | null>(null)
  const [restartPhase, setRestartPhase] = useState<RestartPhase | null>(null)
  const [restartAttempt, setRestartAttempt] = useState(0)
  const [restartOrigin, setRestartOrigin] = useState('')
  const restarting = restartPhase != null

  useEffect(() => {
    let cancelled = false
    api.getProjectConfig()
      .then((c) => {
        if (cancelled) return
        // Stash the as-loaded config for dirty comparison, but project the
        // legacy `auto` value to `external` in the draft so the radio group
        // shows a valid selection. Saving will persist the migrated value.
        setConfig(c)
        setDraft({ ...c, healAgent: migrateLegacyHealAgent(c.healAgent) })
        setPortInput(String(c.port ?? DEFAULT_PORT))
      })
      .catch((e: unknown) => {
        if (cancelled) return
        setError(e instanceof Error ? e.message : 'Failed to load settings')
      })
    return () => { cancelled = true }
  }, [])

  const dirty = draft != null && config != null
    && (
      draft.healAgent !== config.healAgent
      || draft.editor !== config.editor
      || (draft.personalWikiPath ?? '') !== (config.personalWikiPath ?? '')
      || (draft.autoProposePr !== false) !== (config.autoProposePr !== false)
      || (draft.showDemo !== false) !== (config.showDemo !== false)
      || (draft.askModelsOnLaunch === true) !== (config.askModelsOnLaunch === true)
    )

  const onSave = async (): Promise<void> => {
    if (!draft) return
    setSaving(true)
    setError(null)
    try {
      const next = await api.putProjectConfig(draft)
      setConfig(next)
      setDraft(next)
      onClose()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  const redirect = onRedirect ?? defaultRedirect
  const submitPort = async (confirm: boolean): Promise<void> => {
    const port = Number(portInput)
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      setPortError('Port must be an integer between 1 and 65535')
      return
    }
    setPortBusy(true)
    setPortError(null)
    try {
      const res = await api.changeProjectPort(port, confirm)
      if (res.needsConfirm) {
        setPendingConfirm(res.activeRuns ?? 0)
        return
      }
      setPendingConfirm(null)
      if (res.restarting && res.newOrigin) {
        setRestartOrigin(res.newOrigin)
        setRestartAttempt(0)
        setRestartPhase('stopping')
        redirect(res.newOrigin, (phase, attempt) => {
          setRestartPhase(phase)
          setRestartAttempt(attempt)
        })
      }
    } catch (e: unknown) {
      setPortError(e instanceof Error ? e.message : 'Port change failed')
    } finally {
      setPortBusy(false)
    }
  }

  return (
    <>
    <Modal
      open
      onClose={onClose}
      title="Project Settings"
      ariaLabel="Project Settings"
      // The body grows and shrinks with the port confirmation, the restart
      // progress and the gh remediation block — without a reserved gutter the
      // appearing scrollbar shifts every card sideways.
      stableScrollGutter
      footer={
        <>
          {error && <span className="mr-auto text-xs" style={{ color: 'var(--danger)' }}>{error}</span>}
          <button type="button" onClick={onClose} className="cl-button px-3 py-1 text-xs">
            Close
          </button>
          <button
            type="button"
            onClick={onSave}
            disabled={!dirty || saving}
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
        {/* The config dialog's own layout: framed sections in a `gap-3 p-3`
            scroller, the same shape every Advanced setup tab opens with. The
            flat list this replaced put section labels, field controls and row
            labels on three different left edges. */}
        <div className="flex min-h-0 flex-col gap-3 p-3">
          {!draft ? (
            <div className="px-0.5 text-xs" style={{ color: 'var(--text-muted)' }}>
              {error ?? 'Loading…'}
            </div>
          ) : (
            <>
              <Section title="Port">
                <div className="flex items-center gap-2">
                  <input
                    name="port"
                    type="number"
                    min={1}
                    max={65535}
                    value={portInput}
                    onChange={(e) => setPortInput(e.target.value)}
                    disabled={portBusy || restarting}
                    // Surface, border and focus ring all come from `.cl-input`;
                    // the inline copy this replaced re-declared them and pinned
                    // the field to the card's own grey.
                    className="cl-input w-28 px-2 py-1 text-xs"
                  />
                  <button
                    type="button"
                    onClick={() => { void submitPort(false) }}
                    disabled={portBusy || restarting}
                    className="cl-button px-3 py-1 text-xs"
                  >
                    Change port
                  </button>
                </div>
                <Hint>
                  The UI and MCP server bind this port (default {DEFAULT_PORT}). Changing it restarts Canary Lab; your MCP client may need to reconnect (restart it or toggle the connector) if it doesn&apos;t reconnect on its own.
                </Hint>
                {pendingConfirm != null && (
                  <div className="mt-2 text-xs" style={{ color: 'var(--danger)' }}>
                    {pendingConfirm} active run{pendingConfirm === 1 ? '' : 's'} will be aborted by the restart.{' '}
                    <button
                      type="button"
                      onClick={() => { void submitPort(true) }}
                      disabled={portBusy || restarting}
                      className="cl-button px-2 py-0.5 text-xs"
                    >
                      Restart anyway
                    </button>
                  </div>
                )}
                {restartPhase != null && (
                  <RestartProgress
                    phase={restartPhase}
                    attempt={restartAttempt}
                    fromPort={config?.port ?? DEFAULT_PORT}
                    origin={restartOrigin}
                  />
                )}
                {portError && (
                  <div className="mt-1.5 text-xs" style={{ color: 'var(--danger)' }}>{portError}</div>
                )}
              </Section>

              <Section title="Personal wiki">
                <FolderPicker
                  value={draft.personalWikiPath}
                  onChange={(p) => setDraft({ ...draft, personalWikiPath: p.trim() ? p : null })}
                  placeholder="~/Documents/wiki"
                  title="Select personal wiki folder"
                  confirmLabel="Use wiki folder"
                />
                <Hint>
                  Optional Karpathy-style personal wiki folder for distilled agent notes. Auto-heal receives the path and reads only relevant notes.
                </Hint>
              </Section>

              <Section
                title={
                  <span className="flex items-center gap-2">
                    Default agent
                    {/* Scope chip: this section governs Canary's OWN spawns only.
                        External-agent work (MCP) runs on the client's model. */}
                    <span
                      title={INTERNAL_AGENTS_ONLY_COPY}
                      className="rounded-md px-1.5 py-0.5 text-[10px] font-medium normal-case tracking-normal"
                      style={{ color: 'var(--text-muted)', border: '1px solid var(--border-default)' }}
                    >
                      internal agents only
                    </span>
                  </span>
                }
                bodyClassName={OPTION_ROW_SECTION_BODY}
              >
                {HEAL_AGENT_OPTIONS.map((opt, index) => (
                  <div key={opt.value} className={index > 0 ? 'border-t' : ''} style={index > 0 ? { borderColor: 'var(--border-default)' } : undefined}>
                    <ChoiceRow
                      type="radio"
                      name="healAgent"
                      value={opt.value}
                      checked={draft.healAgent === opt.value}
                      onChange={() => setDraft({ ...draft, healAgent: opt.value })}
                      label={opt.label}
                      description={opt.description}
                    />
                    {/* The agent's effective per-stage plan at a glance, with the
                        matrix as the drill-through — indented to the row's label
                        column so it reads as part of the option. */}
                    <div className="flex items-center gap-2 pb-2 pl-[41px] pr-3">
                      <span
                        data-testid={`model-summary-${opt.value}`}
                        className="min-w-0 flex-1 truncate text-[11px]"
                        style={{ color: 'var(--text-muted)' }}
                        title={stagePlanSummary(draft.agentModels?.[opt.value])}
                      >
                        {stagePlanSummary(draft.agentModels?.[opt.value])}
                      </span>
                      <button
                        type="button"
                        data-testid={`configure-models-${opt.value}`}
                        onClick={() => setMatrixAgent(opt.value)}
                        className="cl-button shrink-0 px-2 py-0.5 text-[11px]"
                      >
                        Configure models →
                      </button>
                    </div>
                  </div>
                ))}
                <div className="px-3.5 pb-2 pt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
                  {INTERNAL_AGENTS_ONLY_COPY}
                </div>
              </Section>

              <Section title="At launch" bodyClassName={OPTION_ROW_SECTION_BODY}>
                {ASK_ON_LAUNCH_OPTIONS.map((opt, index) => (
                  <ChoiceRow
                    key={String(opt.value)}
                    type="radio"
                    name="askModelsOnLaunch"
                    value={String(opt.value)}
                    testId={`settings-ask-models-${opt.value}`}
                    checked={(draft.askModelsOnLaunch === true) === opt.value}
                    onChange={() => setDraft({ ...draft, askModelsOnLaunch: opt.value })}
                    label={opt.label}
                    description={opt.description}
                    divider={index > 0}
                  />
                ))}
              </Section>

              <Section title="Editor" bodyClassName={OPTION_ROW_SECTION_BODY}>
                {EDITOR_OPTIONS.map((opt, index) => (
                  <ChoiceRow
                    key={opt.value}
                    type="radio"
                    name="editor"
                    value={opt.value}
                    checked={draft.editor === opt.value}
                    onChange={() => setDraft({ ...draft, editor: opt.value })}
                    label={opt.label}
                    description={opt.description}
                    divider={index > 0}
                  />
                ))}
              </Section>

              {/* The same flag the Getting Started footer toggles. Mirrored here
                  so a workspace that hid the guide can switch it back on — the
                  pill is the dialog's only entry point, so without this the
                  choice would be irreversible. */}
              <Section title="Onboarding" bodyClassName={OPTION_ROW_SECTION_BODY}>
                <ChoiceRow
                  type="checkbox"
                  testId="settings-show-demo"
                  checked={draft.showDemo !== false}
                  onChange={(showDemo) => setDraft({ ...draft, showDemo })}
                  label="Show Getting Started in the status bar"
                  description="Shows the four-step starter journey, followed by the specialized workflows."
                />
              </Section>

              {/* Auto-PR sits with GitHub rather than with the heal agent: what
                  it controls is a push to your remote, not how the repair runs.
                  The connection readout is the section's second ROW, on the same
                  geometry — as a free-standing block it hung its dot, its label
                  and its footnote on three edges none of the rows used. */}
              <Section title="GitHub" bodyClassName={OPTION_ROW_SECTION_BODY}>
                <ChoiceRow
                  type="checkbox"
                  testId="settings-auto-propose-pr"
                  checked={draft.autoProposePr !== false}
                  onChange={(autoProposePr) => setDraft({ ...draft, autoProposePr })}
                  label="Open a draft PR when a run heals green"
                  description="One pull request per suite, force-pushed to the same branch each time so it always carries the newest fix. Nothing is pushed for a run that failed or gave up."
                />
                <GitHubSection divider />
              </Section>
            </>
          )}
        </div>
    </Modal>
    {/* Stacked over settings (Escape closes it first — the layered stack).
        Saves only the agentModels block itself; the settings draft behind
        keeps its unsaved edits and just refreshes its summary lines. */}
    {matrixAgent != null && draft != null && (
      <ModelMatrixDialog
        agent={matrixAgent}
        agentModels={draft.agentModels ?? EMPTY_AGENT_MODELS}
        onClose={() => setMatrixAgent(null)}
        onSaved={(next) => {
          // The server always echoes the block; the guard is the optional-field
          // type (an older server omits it), not a real runtime case.
          const saved = next.agentModels ?? EMPTY_AGENT_MODELS
          setConfig((prev) => (prev ? { ...prev, agentModels: saved } : prev))
          setDraft((prev) => (prev ? { ...prev, agentModels: saved } : prev))
        }}
      />
    )}
    </>
  )
}
