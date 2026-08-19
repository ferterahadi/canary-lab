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
import { Modal, StatusDot, type StatusDotState } from '@/shared/ui/atoms'

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

function targetLabel(target: GettingStartedTarget): string {
  return target.kind === 'flight' ? 'Flight' : 'run'
}

function toneColor(tone: FeedbackTone): string {
  if (tone === 'running') return 'var(--running)'
  if (tone === 'done') return 'var(--success)'
  if (tone === 'blocked') return 'var(--warning)'
  return 'var(--text-muted)'
}

/** The rail's dot: state stays visible on a workflow you aren't reading, so a
 *  run started from here is still legible while you look at another one. */
function railDot(tone: FeedbackTone): StatusDotState {
  if (tone === 'running') return 'running'
  if (tone === 'done') return 'success'
  if (tone === 'blocked') return 'warning'
  return 'idle'
}

function Feedback({ tone, text }: { tone: FeedbackTone; text: string }) {
  const color = toneColor(tone)
  if (text === '') return null
  return (
    <div className="flex h-9 flex-col justify-center" role="status" style={{ color }}>
      <div className="flex items-start gap-1.5 text-[10.5px] leading-snug">
        <span className="mt-[3px] h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: color }} />
        <span className="line-clamp-2">{text}</span>
      </div>
    </div>
  )
}

function resolveCore(workflow: OnboardingWorkflow, session: GettingStartedSessionState, launching: boolean, launchError: string | null, onLaunch: () => void, onOpenTarget: (target: GettingStartedTarget) => void): Resolved {
  const active = session.active
  const isActive = active?.workflow === workflow.id
  const completion = workflow.id === 'run' || workflow.id === 'flight'
    ? session.completed[workflow.id]
    : undefined
  const internalTarget = isActive && active?.owner === 'internal' ? active.target : null
  const referenceTarget = internalTarget ?? completion?.target ?? null
  const unavailable = workflow.unavailableReason !== null || workflow.internalAction === null
  const blocked = active !== null && !isActive

  let actionLabel = 'Run in Canary Lab'
  if (launching) actionLabel = 'Starting…'
  else if (internalTarget) actionLabel = `Open ${targetLabel(internalTarget)}`
  else if (isActive && active.owner === 'external') actionLabel = 'Running in your agent'
  else if (isActive) actionLabel = 'Starting…'
  else if (referenceTarget) actionLabel = `Open last ${targetLabel(referenceTarget)}`

  let feedback: { tone: FeedbackTone; text: string } = { tone: 'ready', text: workflow.unavailableReason ?? '' }
  if (launchError) feedback = { tone: 'blocked', text: launchError }
  else if (blocked) feedback = {
    tone: 'blocked',
    text: `${active.workflow === 'flight' ? 'Full Flight' : 'Run and Heal'} is running. Try this when it finishes.`,
  }
  else if (isActive && active.owner === 'external') feedback = {
    tone: 'running',
    text: 'Running in your agent · Follow progress in your Claude or Codex session.',
  }
  else if (isActive) feedback = {
    tone: 'running',
    text: `Running · Continue in the ${active.target ? targetLabel(active.target) : 'progress'} page.`,
  }
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

function resolveMore(workflow: OnboardingWorkflow, session: GettingStartedSessionState, blocker: string | undefined, launching: boolean, launchError: string | null, onLaunch: () => void): Resolved {
  const blocked = session.active !== null
  const unavailableReason = workflow.unavailableReason ?? blocker ?? null
  const kind = workflow.internalAction?.kind
  const actionLabel = kind && kind !== 'run' && kind !== 'flight' ? MORE_ACTION_LABEL[kind] : 'Run in Canary Lab'
  const feedback: { tone: FeedbackTone; text: string } = launchError
    ? { tone: 'blocked', text: launchError }
    : blocked
      ? { tone: 'blocked', text: 'A demo is running. Try this when it finishes.' }
      : { tone: 'ready', text: unavailableReason ?? '' }
  return {
    actionLabel: launching ? 'Starting…' : actionLabel,
    actionDisabled: blocked || launching || unavailableReason !== null || !workflow.internalAction,
    copyDisabled: blocked || launching || workflow.unavailableReason !== null,
    onAction: onLaunch,
    feedback,
  }
}

function RailGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="pb-2">
      <div className="cl-rubric px-4 pb-1.5">{label}</div>
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
      className="cl-hover-row flex w-full cursor-pointer items-center gap-2 px-4 py-1.5 text-left text-[11.5px]"
      style={{
        background: selected ? 'var(--bg-selected)' : 'transparent',
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
    <div data-testid="getting-started-detail" className="flex min-w-0 flex-col gap-3 px-4 py-3.5">
      <div className="min-w-0">
        <h3 className="text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>{workflow.title}</h3>
        <p className="mt-1 text-[11.5px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>{workflow.outcome}</p>
        {/* Ordered steps as a chevron chain — these are a sequence, so arrows
            say more than the bordered boxes did. Mono numerals keep the index
            reading as position rather than as prose. */}
        <ol className="mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px]">
          {workflow.steps.map((step, index) => (
            <li key={step} className="flex items-center gap-1.5">
              {index > 0 && <span aria-hidden style={{ color: 'var(--border-strong)' }}>›</span>}
              <span className="font-mono tabular-nums" style={{ color: 'var(--text-muted)' }}>{index + 1}</span>
              <span style={{ color: 'var(--text-secondary)' }}>{step}</span>
            </li>
          ))}
        </ol>
      </div>

      {/* Two ways to run the SAME workflow, as two rows of one frame. A button
          stacked over a command field read as step one then step two — the
          numbered sequence above them primes exactly that. Side-by-side cards
          said "either" but sized themselves to their contents, so a button box
          sat next to a much wider command box. Full-width rows keep the pair
          the same size and let the label column carry the difference. */}
      <div>
        <div className="cl-rubric mb-2">Two ways to run it</div>
        <div
          className="overflow-hidden rounded-lg border"
          style={{ borderColor: 'var(--border-default)', background: 'var(--bg-surface)', boxShadow: 'var(--shadow-panel)' }}
        >
          <div className="flex items-center gap-3 border-b px-3 py-2.5" style={{ borderColor: 'var(--border-default)' }}>
            <div className="w-[150px] shrink-0">
              <div className="text-[11px] font-medium" style={{ color: 'var(--text-primary)' }}>In Canary Lab</div>
              <p className="mt-0.5 text-[10px] leading-snug" style={{ color: 'var(--text-muted)' }}>Runs in this workspace.</p>
            </div>
            {/* Both rows give their control the same column, so the pair reads
                as one choice rather than as a small box beside a wide one. The
                state line sits under the button in that column — absent at
                rest, so the two rows stay the same height until there is news. */}
            <div className="min-w-0 flex-1">
              <button
                type="button"
                data-testid={`getting-started-action-${workflow.id}`}
                disabled={resolved.actionDisabled}
                onClick={resolved.onAction}
                className="cl-button-primary w-full px-3.5 py-1.5 text-[11px] disabled:cursor-not-allowed disabled:opacity-50"
              >
                <span className="block truncate">{resolved.actionLabel}</span>
              </button>
              <Feedback {...resolved.feedback} />
            </div>
          </div>

          <div className="flex items-center gap-3 px-3 py-2.5">
            <div className="w-[150px] shrink-0">
              <div className="text-[11px] font-medium" style={{ color: 'var(--text-primary)' }}>In your agent</div>
              <p className="mt-0.5 text-[10px] leading-snug" style={{ color: 'var(--text-muted)' }}>Paste it in Claude or Codex.</p>
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
        </div>
      </div>
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

  const resolve = (workflow: OnboardingWorkflow): Resolved => workflow.group === 'start'
    ? resolveCore(workflow, session, launching === workflow.id, launchErrors[workflow.id] ?? null, () => launch(workflow), onOpenTarget)
    : resolveMore(workflow, session, actionBlockers[workflow.id], launching === workflow.id, launchErrors[workflow.id] ?? null, () => launch(workflow))

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
        <label className="mr-auto flex cursor-pointer items-center gap-2 text-[11px]" style={{ color: 'var(--text-muted)' }}>
          <input
            type="checkbox"
            data-testid="demo-show-toggle"
            checked={showDemo !== false}
            onChange={(event) => onShowDemoChange(event.target.checked)}
          />
          Show in the status bar
        </label>
      )}
    >
      <div className="grid h-full min-h-0 grid-cols-[210px_minmax(0,1fr)]">
        <nav
          aria-label="Getting Started workflows"
          className="min-h-0 overflow-y-auto border-r py-3.5 scrollbar-thin"
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
