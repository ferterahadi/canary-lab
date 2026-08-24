import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type {
  GettingStartedSessionState,
  GettingStartedTarget,
  OnboardingWorkflow,
  OnboardingWorkflowAction,
  OnboardingWorkflowId,
} from '@/shared/api/client'
import { CopyField } from '@/shared/ui/CopyField'
import { Tooltip } from '@/shared/ui/Tooltip'
import { Modal, Section, StatusDot, type StatusDotState } from '@/shared/ui/atoms'
import { OPTION_ROW_CENTERED_CLASS, OPTION_ROW_SECTION_BODY, optionRowStyle } from '@/shared/ui/OptionRow'

const MORE_ACTION_LABEL: Record<Exclude<OnboardingWorkflowAction['kind'], 'run' | 'flight'>, string> = {
  coverage: 'Measure coverage',
  author: 'Author test',
  portify: 'Enable parallel runs',
  verify: 'Start app and verify',
  export: 'Export evaluation',
}

type FeedbackTone = 'ready' | 'running' | 'done' | 'blocked'

/** What the picked workflow offers right now. Both groups resolve into this
 *  one shape so the detail pane renders a single thing rather than branching
 *  on which list the workflow came from. */
interface Resolved {
  actionLabel: string
  actionDisabled: boolean
  copyDisabled: boolean
  onAction: () => void
  feedback: { tone: FeedbackTone; text: string }
}

/** Card titles for the blocked line ("Waiting for … to finish"). Mirrors the
 *  server's onboarding titles — the active claim carries only the workflow key. */
const WORKFLOW_WAIT_LABEL: Record<string, string> = {
  run: 'Repair a Broken Suite',
  flight: 'Full Flight',
  coverage: 'Measure Coverage',
  author: 'Author Tests',
  portify: 'Enable Parallel Runs',
  verify: 'Verify a Running App',
  export: 'Export an Evaluation',
}

/** What "Open <this>" opens: coverage jobs land on the coverage ledger, runs on
 *  the run detail, everything else on the suite's Flight page (pinned stage). */
function targetLabel(target: GettingStartedTarget): string {
  if (target.kind === 'run') return 'run'
  if (target.kind === 'coverage-job') return 'coverage'
  return 'Flight'
}

/** The rail's dot: state stays visible on a workflow you aren't reading, so a
 *  run started from here is still legible while you look at another one. */
function railDot(tone: FeedbackTone): StatusDotState {
  if (tone === 'running') return 'running'
  if (tone === 'done') return 'success'
  if (tone === 'blocked') return 'warning'
  return 'idle'
}

/** The action, carrying the workflow's live state as a dot on the button with
 *  the wording in a tooltip. A full-colour sentence next to the button shouted
 *  a one-line status at the same volume as the action itself, and stacking it
 *  under the button resized the card every time a demo started or finished. A
 *  dot says "there is news, and what kind" at 9px; the sentence is one hover
 *  away, and stays in a live region for a screen reader that gets no hover.
 *
 *  The tooltip hangs off a wrapper, not the button: a disabled button swallows
 *  hover, and the states that most need explaining (blocked, unavailable) are
 *  exactly the disabled ones. */
function ActionButton({ workflow, resolved }: { workflow: OnboardingWorkflow; resolved: Resolved }) {
  const { tone, text } = resolved.feedback
  const control = (
    <span className="relative flex min-w-0 flex-1" style={{ cursor: text === '' ? undefined : 'help' }}>
      <button
        type="button"
        data-testid={`getting-started-action-${workflow.id}`}
        disabled={resolved.actionDisabled}
        onClick={resolved.onAction}
        style={resolved.actionDisabled ? { pointerEvents: 'none' } : undefined}
        className="cl-button relative w-full px-3 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-50"
      >
        {/* Absolute so the label stays centred: a dot in the flex line would
            nudge the wording sideways the moment a demo started. */}
        {tone !== 'ready' && (
          <StatusDot state={railDot(tone)} className="absolute left-2.5 top-1/2 -translate-y-1/2" />
        )}
        <span className="block truncate">{resolved.actionLabel}</span>
      </button>
    </span>
  )
  return (
    <>
      {text === '' ? control : <Tooltip label={text}>{control}</Tooltip>}
      {/* Outside the conditional so the live region is never remounted — one
          that appears with the news does not reliably announce it. */}
      <span className="sr-only" role="status">{text}</span>
    </>
  )
}

/** One resolution ladder for BOTH rail groups: every workflow now claims a
 *  session, so every card gets the same live verb, open-target button, blocked
 *  line and completion receipt. `blocker` is the More-group precondition
 *  ("Complete Run and Heal first.") — folded into unavailability so it gates
 *  the button and the copied command identically. */
function resolveWorkflow(workflow: OnboardingWorkflow, session: GettingStartedSessionState, blocker: string | undefined, launching: boolean, launchError: string | null, onLaunch: () => void, onOpenTarget: (target: GettingStartedTarget) => void): Resolved {
  const active = session.active
  const isActive = active?.workflow === workflow.id
  const completion = session.completed[workflow.id]
  const internalTarget = isActive && active?.owner === 'internal' ? active.target : null
  const referenceTarget = internalTarget ?? completion?.target ?? null
  const unavailableReason = workflow.unavailableReason ?? blocker ?? null
  const unavailable = unavailableReason !== null || workflow.internalAction === null
  const blocked = active !== null && !isActive

  const kind = workflow.internalAction?.kind
  const idleLabel = kind && kind !== 'run' && kind !== 'flight' ? MORE_ACTION_LABEL[kind] : 'Run in Canary Lab'
  let actionLabel = idleLabel
  if (launching) actionLabel = 'Starting…'
  else if (internalTarget) actionLabel = `Open ${targetLabel(internalTarget)}`
  else if (isActive && active.owner === 'external') actionLabel = 'Running in your agent'
  else if (isActive) actionLabel = 'Starting…'
  else if (referenceTarget) actionLabel = `Open last ${targetLabel(referenceTarget)}`

  let feedback: { tone: FeedbackTone; text: string } = { tone: 'ready', text: unavailableReason ?? '' }
  if (launchError) feedback = { tone: 'blocked', text: launchError }
  else if (blocked) feedback = {
    tone: 'blocked',
    text: `Waiting for ${WORKFLOW_WAIT_LABEL[active.workflow] ?? 'the running demo'} to finish.`,
  }
  else if (isActive && active.owner === 'external') feedback = {
    tone: 'running',
    text: 'Running in your Claude or Codex session.',
  }
  else if (isActive) feedback = {
    tone: 'running',
    text: `Running · Continue in the ${active.target ? targetLabel(active.target) : 'progress'} page.`,
  }
  // A paused flight settles the claim but is NOT a completion to the user —
  // "Completed · Last result: paused." read as a contradiction on the demo's
  // most likely mid-tour state.
  else if (completion?.status === 'paused') feedback = { tone: 'done', text: 'Paused · Continue from the Flight page.' }
  else if (completion) feedback = { tone: 'done', text: `Completed · Last result: ${completion.status}.` }

  return {
    actionLabel,
    actionDisabled: unavailable || blocked || launching || (isActive && internalTarget === null),
    copyDisabled: unavailable || active !== null || launching,
    onAction: () => referenceTarget && !isActive
      ? onOpenTarget(referenceTarget)
      : internalTarget ? onOpenTarget(internalTarget) : onLaunch(),
    feedback,
  }
}

function RailGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="pb-2">
      <div className="cl-rubric px-3.5 pb-1.5">{label}</div>
      {children}
    </div>
  )
}

/** A workflow's persistent row. Selection is the app's selected-grey, never an
 *  accent — every row here is clickable, so accent would say nothing. */
function RailRow({ workflow, selected, tone, onSelect }: {
  workflow: OnboardingWorkflow
  selected: boolean
  tone: FeedbackTone
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      data-testid={`getting-started-workflow-${workflow.id}`}
      aria-current={selected}
      onClick={onSelect}
      // Selection and the pointer come from the shared option-row helper — the
      // same one the settings dialog's choice rows use. The inline `background`
      // plus a hand-written `cursor-pointer` this replaced re-stated both by
      // hand and was free to drift from them.
      className={`${selected ? '' : 'cl-hover-row'} flex w-full items-center gap-2 px-3.5 py-1.5 text-left text-[11.5px]`}
      style={{
        ...optionRowStyle({ selected, interactive: true }),
        color: selected ? 'var(--text-primary)' : 'var(--text-secondary)',
      }}
    >
      <span className="min-w-0 flex-1 truncate">{workflow.title}</span>
      <span className="flex h-2 w-2 shrink-0 items-center justify-center">
        {tone !== 'ready' && <StatusDot state={railDot(tone)} />}
      </span>
    </button>
  )
}

function Detail({ workflow, resolved }: { workflow: OnboardingWorkflow; resolved: Resolved }) {
  return (
    // The config dialog's scroller shape — framed sections in a `gap-3 p-3`
    // inset, the same one every Advanced setup tab and Project Settings opens
    // with. This pane used to be a `px-4 py-3.5` block with a hand-rolled frame
    // inside it, so the two dialogs sat on different insets and different type.
    <div data-testid="getting-started-detail" className="flex min-w-0 flex-col gap-3 p-3">
      {/* Reserved so switching workflows in the rail never floats the frame
          below up or down — the card stays put and only its contents change. */}
      <div className="min-h-[84px] min-w-0 px-0.5">
        {/* `.cl-kicker` and a 12px secondary line: the app's section-heading
            voice over its body voice, the same pair the settings sections use.
            The ad-hoc 13px/500 over 11.5px this replaced was a register of its
            own that existed nowhere else. */}
        <h3 className="cl-kicker">{workflow.title}</h3>
        <p className="mt-1 text-xs leading-relaxed" style={{ color: 'var(--text-secondary)' }}>{workflow.outcome}</p>
        {/* Ordered steps as a chevron chain — these are a sequence, so arrows
            say more than the bordered boxes did. Mono numerals keep the index
            reading as position rather than as prose. */}
        <ol className="mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
          {workflow.steps.map((step, index) => (
            <li key={step} className="flex items-center gap-1.5">
              {index > 0 && <span aria-hidden style={{ color: 'var(--border-strong)' }}>›</span>}
              <span className="font-mono tabular-nums" style={{ color: 'var(--text-muted)' }}>{index + 1}</span>
              <span style={{ color: 'var(--text-secondary)' }}>{step}</span>
            </li>
          ))}
        </ol>
      </div>

      {/* Two ways to run the SAME workflow, as two rows of one section. A button
          stacked over a command field read as step one then step two — the
          numbered sequence above them primes exactly that. Side-by-side cards
          said "either" but sized themselves to their contents, so a button box
          sat next to a much wider command box. Full-width rows keep the pair
          the same size and let the label column carry the difference.

          The frame is the shared `Section` on the shared row-body inset, so the
          header band, border, surface and radius are the settings dialog's and
          cannot drift from it. Live state rides the button itself as a dot, so
          the card is the same height whether a demo has never run, is running,
          or has finished. */}
      <Section title="Two ways to run it" bodyClassName={OPTION_ROW_SECTION_BODY}>
        <div className={OPTION_ROW_CENTERED_CLASS} style={optionRowStyle({ selected: false })}>
          <div className="w-[150px] shrink-0">
            {/* 12.5/medium over a 12px muted description — the option-row label
                pair used by every choice row in Project Settings. */}
            <div className="text-[12.5px] font-medium" style={{ color: 'var(--text-primary)' }}>In Canary Lab</div>
            <p className="mt-0.5 text-xs leading-snug" style={{ color: 'var(--text-muted)' }}>Runs in this workspace.</p>
          </div>
          {/* Both rows give their control the same column AND the same weight.
              The accent-filled skin made this row win every time it was on
              screen, which is the opposite of "either way" — an accent fill
              next to a plain field reads as the real option beside a footnote.
              Neutral on both sides lets the label column carry the difference. */}
          <ActionButton workflow={workflow} resolved={resolved} />
        </div>

        <div className={`${OPTION_ROW_CENTERED_CLASS} border-t`} style={optionRowStyle({ selected: false })}>
          <div className="w-[150px] shrink-0">
            <div className="text-[12.5px] font-medium" style={{ color: 'var(--text-primary)' }}>In your agent</div>
            <p className="mt-0.5 text-xs leading-snug" style={{ color: 'var(--text-muted)' }}>Paste it in Claude or Codex.</p>
          </div>
          {/* CopyField carries its own 4px top margin for stacked use; in a row
              it would sit 4px below centre, so the wrapper cancels it. */}
          <div className="-mt-1 min-w-0 flex-1">
            <CopyField
              value={workflow.externalPrompt}
              label={`${workflow.title} command`}
              testId={`getting-started-command-${workflow.id}`}
              buttonTestId={`getting-started-copy-${workflow.id}`}
              disabled={resolved.copyDisabled}
            />
          </div>
        </div>
      </Section>
    </div>
  )
}

export function DemoDialog({ open, onClose, workflows, session, actionBlockers = {}, onInternalAction, onOpenTarget, showDemo, onShowDemoChange }: {
  open: boolean
  onClose: () => void
  workflows: OnboardingWorkflow[]
  session: GettingStartedSessionState
  actionBlockers?: Partial<Record<OnboardingWorkflowId, string>>
  onInternalAction: (action: OnboardingWorkflowAction) => Promise<void> | void
  onOpenTarget: (target: GettingStartedTarget) => void
  showDemo: boolean | null
  onShowDemoChange: (next: boolean) => void
}) {
  const [picked, setPicked] = useState<OnboardingWorkflowId | null>(null)
  const [launching, setLaunching] = useState<OnboardingWorkflowId | null>(null)
  const [launchErrors, setLaunchErrors] = useState<Partial<Record<OnboardingWorkflowId, string>>>({})
  const core = useMemo(() => workflows.filter((item) => item.group === 'start').sort((a, b) => a.order - b.order), [workflows])
  const more = useMemo(() => workflows.filter((item) => item.group === 'more').sort((a, b) => a.order - b.order), [workflows])

  const launch = (workflow: OnboardingWorkflow): void => {
    if (!workflow.internalAction) return
    setLaunching(workflow.id)
    setLaunchErrors((current) => ({ ...current, [workflow.id]: undefined }))
    Promise.resolve(onInternalAction(workflow.internalAction))
      .catch((error: unknown) => setLaunchErrors((current) => ({
        ...current,
        [workflow.id]: error instanceof Error ? error.message : String(error),
      })))
      .finally(() => setLaunching((current) => current === workflow.id ? null : current))
  }

  const resolve = (workflow: OnboardingWorkflow): Resolved =>
    resolveWorkflow(workflow, session, actionBlockers[workflow.id], launching === workflow.id, launchErrors[workflow.id] ?? null, () => launch(workflow), onOpenTarget)

  // The rail always opens on something: a running demo owns the view, else the
  // first starter. A dialog that opens on an empty pane teaches nothing.
  const ordered = [...core, ...more]
  const selected = ordered.find((item) => item.id === picked)
    ?? ordered.find((item) => item.id === session.active?.workflow)
    ?? ordered[0]

  return (
    <Modal
      open={open}
      onClose={onClose}
      eyebrow="Getting started"
      title="See Canary Lab in action"
      width={760}
      height={432}
      testId="demo-dialog"
      footer={(
        <label className="mr-auto flex cursor-pointer items-center gap-2 text-xs" style={{ color: 'var(--text-muted)' }}>
          {/* Same 13px accent-tinted native mark as every choice row in Project
              Settings — untinted it fell back to the browser's own blue, which
              is the one colour in this dialog that isn't ours. */}
          <input
            type="checkbox"
            data-testid="demo-show-toggle"
            checked={showDemo !== false}
            onChange={(event) => onShowDemoChange(event.target.checked)}
            className="h-[13px] w-[13px] shrink-0"
            style={{ accentColor: 'var(--accent)' }}
          />
          Show in the status bar
        </label>
      )}
    >
      <div className="grid h-full min-h-0 grid-cols-[210px_minmax(0,1fr)]">
        <nav
          aria-label="Getting Started workflows"
          className="min-h-0 overflow-y-auto border-r py-3 scrollbar-thin"
          style={{ borderColor: 'var(--border-default)', background: 'var(--bg-surface)' }}
        >
          <RailGroup label="Start here">
            {core.map((workflow) => (
              <RailRow
                key={workflow.id}
                workflow={workflow}
                selected={workflow.id === selected?.id}
                tone={resolve(workflow).feedback.tone}
                onSelect={() => setPicked(workflow.id)}
              />
            ))}
          </RailGroup>
          <RailGroup label="More workflows">
            {more.map((workflow) => (
              <RailRow
                key={workflow.id}
                workflow={workflow}
                selected={workflow.id === selected?.id}
                tone={resolve(workflow).feedback.tone}
                onSelect={() => setPicked(workflow.id)}
              />
            ))}
          </RailGroup>
        </nav>
        <div className="min-h-0 overflow-y-auto scrollbar-thin">
          {selected && <Detail workflow={selected} resolved={resolve(selected)} />}
        </div>
      </div>
    </Modal>
  )
}
