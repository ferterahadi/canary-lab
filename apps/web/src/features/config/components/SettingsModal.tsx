import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import * as api from '@/shared/api/client'
import type { ModelAgentKind, ProjectConfig } from '@/shared/api/client'
import { EMPTY_AGENT_MODELS } from '@shared/agent-models'
import { HintIcon, Modal, Section, SlidersIcon } from '@/shared/ui/atoms'
import { OPTION_ROW_CLASS, OPTION_ROW_COMPACT_CLASS, OPTION_ROW_SECTION_BODY, optionRowStyle } from '@/shared/ui/OptionRow'
import { FolderPicker } from './FolderPicker'
import { GitHubSection } from './GitHubSection'
import { ModelMatrixDialog } from './ModelMatrixDialog'
import { RestartPhase, RestartProgress, defaultRedirect } from './SettingsRestartProgress'
import {
  ASK_ON_LAUNCH_DESCRIPTION,
  ASK_ON_LAUNCH_HELP,
  ASK_ON_LAUNCH_LABEL,
  DEFAULT_AGENT_HELP,
  DEFAULT_PORT,
  EDITOR_OPTIONS,
  HEAL_AGENT_OPTIONS,
  PORT_HELP,
  PORT_SUMMARY,
  SETTINGS_ACTION_CLASS,
  WIKI_HELP,
  WIKI_SUMMARY,
  migrateLegacyEditor,
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
function ChoiceRow({ type, name, value, checked, onChange, label, description, help, helpLabel, testId, divider }: {
  type: 'radio' | 'checkbox'
  name?: string
  value?: string
  checked: boolean
  onChange: (checked: boolean) => void
  label: string
  description: string
  /** Secondary explanation, hung off a `ⓘ` beside the label — the row-level
   *  twin of the `ⓘ` a section title carries. For scope and caveats that would
   *  push the visible description past its one line. */
  help?: string
  helpLabel?: string
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
        <span className="flex items-center gap-1.5">
          <span className="text-[12.5px] font-medium" style={{ color: 'var(--text-primary)' }}>{label}</span>
          {help && <HintIcon hint={help} label={helpLabel} />}
        </span>
        <span className="mt-0.5 block text-xs" style={{ color: 'var(--text-muted)' }}>{description}</span>
      </span>
    </label>
  )
}

/** Default-agent rows carry their drill-through action on the same line. The
 *  button is a sibling of the label rather than nested inside it: clicking
 *  Configure must not also change the selected radio. */
function AgentChoiceRow({ value, label, checked, summary, divider, onChange, onConfigure }: {
  value: string
  label: string
  checked: boolean
  summary: string | null
  divider: boolean
  onChange: () => void
  onConfigure: () => void
}) {
  return (
    <div
      data-testid={`agent-choice-${value}`}
      className={`${OPTION_ROW_COMPACT_CLASS} ${checked ? '' : 'cl-hover-row'} ${divider ? 'border-t' : ''}`}
      style={optionRowStyle({ selected: checked, interactive: true })}
    >
      <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-3">
        <input
          type="radio"
          name="healAgent"
          value={value}
          checked={checked}
          onChange={onChange}
          className="h-[13px] w-[13px] shrink-0"
          style={{ accentColor: 'var(--accent)' }}
        />
        <span className="shrink-0 text-[12.5px] font-medium" style={{ color: 'var(--text-primary)' }}>{label}</span>
        {summary && (
          // 12px muted — the one secondary-text size this dialog uses for a
          // line that qualifies a label. At 11px it was a fourth type size on
          // a card that already had three.
          <span
            data-testid={`model-summary-${value}`}
            className="min-w-0 flex-1 truncate text-xs"
            style={{ color: 'var(--text-muted)' }}
            title={summary}
          >
            {summary}
          </span>
        )}
      </label>
      {/* An icon, not "Configure models →". The label repeated on every agent
          row and out-measured the choice it qualified; the row's real content
          is which agent and what its models are. Both agents keep their own
          gear — a flight can be launched with the agent that isn't your
          default, so its saved plans still matter. */}
      <button
        type="button"
        data-testid={`configure-models-${value}`}
        onClick={onConfigure}
        aria-label={`Configure ${label} models`}
        title={`Configure ${label} models`}
        className="cl-icon-button h-6 w-6 shrink-0"
      >
        <SlidersIcon />
      </button>
    </div>
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
        // Stash the as-loaded config for dirty comparison, but project retired
        // choices onto their live UI values so every radio group has a valid
        // selection. Saving through an older server persists the migration.
        setConfig(c)
        setDraft({
          ...c,
          healAgent: migrateLegacyHealAgent(c.healAgent),
          editor: migrateLegacyEditor(c.editor),
        })
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
              <Section
                title={
                  <span className="inline-flex items-center gap-1.5">
                    Port
                    <HintIcon hint={PORT_HELP} label="Port help" />
                  </span>
                }
              >
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
                    className={SETTINGS_ACTION_CLASS}
                  >
                    Change port
                  </button>
                </div>
                <Hint>{PORT_SUMMARY}</Hint>
                {/* The app's notice-with-a-remedy shape (the model matrix's
                    probe warning): a tinted, hairline-bordered block whose
                    action sits at its right edge — not a red sentence with a
                    button spliced mid-line. The hue stays danger: what it
                    warns about is losing active runs. */}
                {pendingConfirm != null && (
                  <div
                    className="mt-2 flex items-start gap-2 rounded-md px-2.5 py-2 text-xs"
                    style={{
                      color: 'var(--text-primary)',
                      border: '1px solid color-mix(in srgb, var(--danger) 35%, transparent)',
                      background: 'color-mix(in srgb, var(--danger) 8%, transparent)',
                    }}
                  >
                    <span className="min-w-0 flex-1">
                      {pendingConfirm} active run{pendingConfirm === 1 ? '' : 's'} will be aborted by the restart.
                    </span>
                    <button
                      type="button"
                      onClick={() => { void submitPort(true) }}
                      disabled={portBusy || restarting}
                      className={`${SETTINGS_ACTION_CLASS} shrink-0`}
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

              <Section
                title={
                  <span className="inline-flex items-center gap-1.5">
                    Personal wiki
                    <HintIcon hint={WIKI_HELP} label="Personal wiki help" />
                  </span>
                }
              >
                <FolderPicker
                  value={draft.personalWikiPath}
                  onChange={(p) => setDraft({ ...draft, personalWikiPath: p.trim() ? p : null })}
                  placeholder="~/Documents/wiki"
                  title="Select personal wiki folder"
                  confirmLabel="Use wiki folder"
                />
                <Hint>{WIKI_SUMMARY}</Hint>
              </Section>

              {/* One card, because it is one subject: which agent Canary Lab
                  starts, what models that agent gets, and whether a launch
                  stops to confirm them. As two cards the pair read as two
                  unrelated settings that happened to look alike — the same
                  header band, the same two radio rows, twice — and cost four
                  rows plus a second header to carry three facts. */}
              <Section
                title={
                  <span className="inline-flex items-center gap-1.5">
                    Agent
                    <HintIcon hint={DEFAULT_AGENT_HELP} label="Default agent help" />
                  </span>
                }
                bodyClassName={OPTION_ROW_SECTION_BODY}
              >
                {HEAL_AGENT_OPTIONS.map((opt, index) => (
                  <AgentChoiceRow
                    key={opt.value}
                    value={opt.value}
                    label={opt.label}
                    checked={draft.healAgent === opt.value}
                    summary={stagePlanSummary(draft.agentModels?.[opt.value])}
                    divider={index > 0}
                    onChange={() => setDraft({ ...draft, healAgent: opt.value })}
                    onConfigure={() => setMatrixAgent(opt.value)}
                  />
                ))}
                {/* A checkbox on the same geometry as the Onboarding and
                    auto-PR rows, not a switch: it is the dialog's third
                    standalone on/off setting, and the other two are checkboxes.
                    One row shape for one kind of decision. */}
                <ChoiceRow
                  type="checkbox"
                  testId="settings-ask-models"
                  label={ASK_ON_LAUNCH_LABEL}
                  description={ASK_ON_LAUNCH_DESCRIPTION}
                  help={ASK_ON_LAUNCH_HELP}
                  helpLabel="At launch help"
                  checked={draft.askModelsOnLaunch === true}
                  onChange={(askModelsOnLaunch) => setDraft({ ...draft, askModelsOnLaunch })}
                  divider
                />
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
                  label="Open a draft PR when a repair succeeds"
                  description="Creates one draft PR per suite and keeps it updated with the latest fix. Failed repairs are never pushed."
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
