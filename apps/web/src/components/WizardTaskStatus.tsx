import { useMemo, useState } from 'react'
import type { DraftRecord } from '../api/types'
import { slugifyFeatureName } from '../lib/wizard-validation'
import { isActiveWizardTask, useWizardDrafts } from '../state/WizardDraftContext'
import { CloseIcon, StatusDot, type StatusDotState } from './config/atoms'

function dotStateForDraft(status: DraftRecord['status']): StatusDotState {
  if (status === 'plan-ready' || status === 'spec-ready' || status === 'accepted') return 'success'
  if (status === 'error') return 'failed'
  if (status === 'cancelled' || status === 'rejected') return 'warning'
  if (status === 'created') return 'idle'
  return 'running'
}

type FilterKey = 'running' | 'ready' | 'failed' | 'created'
type Tone = 'running' | 'ready' | 'failed' | 'idle' | 'neutral'

export function WizardTaskStatus() {
  const {
    drafts,
    latestTask,
    selectedDraft,
    wizardOpen,
    openTask,
    cancelGeneration,
    deleteTask,
  } = useWizardDrafts()
  const [dialogOpen, setDialogOpen] = useState(false)

  if (!latestTask) return null

  const openDraft = (draftId: string): void => {
    setDialogOpen(false)
    openTask(draftId)
  }

  const activeSelectedId = wizardOpen ? selectedDraft?.draftId ?? null : null

  return (
    <>
      <div className="flex min-w-0 shrink-0 items-center">
        <button
          type="button"
          onClick={() => setDialogOpen(true)}
          className="cl-button flex min-w-0 max-w-[260px] items-center gap-2 px-2 py-0.5 text-[11px]"
          style={{ color: 'var(--text-secondary)' }}
          title={`${statusLabel(latestTask)}: ${taskTitle(latestTask)}`}
        >
          <StatusDot state={dotStateForDraft(latestTask.status)} />
          <span className="shrink-0 font-medium" style={{ color: 'var(--text-primary)' }}>
            Wizards
          </span>
          <span className="hidden min-w-0 truncate xl:inline" style={{ color: 'var(--text-muted)' }}>
            {compactStatusLabel(latestTask)}
          </span>
          <span className="shrink-0 rounded px-1.5 py-0.5 text-[10px]" style={{ background: 'var(--bg-selected)', color: 'var(--text-muted)' }}>
            {drafts.length}
          </span>
        </button>
      </div>
      {dialogOpen && (
        <WizardTaskDialog
          tasks={drafts}
          activeSelectedId={activeSelectedId}
          onClose={() => setDialogOpen(false)}
          onOpen={openDraft}
          onStop={(draftId) => void cancelGeneration(draftId)}
          onDismiss={(draftId) => void deleteTask(draftId)}
        />
      )}
    </>
  )
}

function WizardTaskDialog({
  tasks,
  activeSelectedId,
  onClose,
  onOpen,
  onStop,
  onDismiss,
}: {
  tasks: DraftRecord[]
  activeSelectedId: string | null
  onClose: () => void
  onOpen: (draftId: string) => void
  onStop: (draftId: string) => void
  onDismiss: (draftId: string) => void
}) {
  const counts = taskCounts(tasks)
  const [filter, setFilter] = useState<FilterKey | null>(null)

  const filtered = useMemo(() => (
    filter ? tasks.filter((task) => filterMatches(task, filter)) : tasks
  ), [filter, tasks])

  const toggle = (key: FilterKey): void => {
    setFilter((current) => (current === key ? null : key))
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-end bg-black/30 p-6">
      <section
        role="dialog"
        aria-modal="true"
        aria-label="Wizard tasks"
        className="flex max-h-[calc(100vh-3rem)] w-[min(720px,calc(100vw-3rem))] flex-col rounded-lg border shadow-2xl"
        style={{
          borderColor: 'var(--border-default)',
          background: 'var(--bg-elevated)',
          color: 'var(--text-primary)',
        }}
      >
        <header
          className="flex items-center gap-3 border-b px-4 py-3"
          style={{ borderColor: 'var(--border-default)' }}
        >
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold">Wizard tasks</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded px-2 py-1 text-xs"
            style={{ color: 'var(--text-secondary)' }}
          >
            Close
          </button>
        </header>

        <div
          className="flex flex-wrap items-center gap-1.5 border-b px-4 py-2"
          role="tablist"
          aria-label="Filter tasks"
          style={{ borderColor: 'var(--border-default)' }}
        >
          <FilterPill label="All" value={tasks.length} tone="neutral" active={filter === null} onClick={() => setFilter(null)} />
          <FilterPill label="Running" value={counts.running} tone="running" active={filter === 'running'} onClick={() => toggle('running')} />
          <FilterPill label="Ready" value={counts.ready} tone="ready" active={filter === 'ready'} onClick={() => toggle('ready')} />
          <FilterPill label="Failed" value={counts.failed} tone="failed" active={filter === 'failed'} onClick={() => toggle('failed')} />
          <FilterPill label="Drafts" value={counts.created} tone="idle" active={filter === 'created'} onClick={() => toggle('created')} />
        </div>

        <div className="min-h-0 flex-1 overflow-auto p-2 scrollbar-thin">
          {filtered.length === 0 ? (
            <EmptyState filter={filter} totalTasks={tasks.length} />
          ) : (
            <ul role="list" className="flex flex-col gap-1">
              {filtered.map((task) => (
                <TaskRow
                  key={task.draftId}
                  task={task}
                  selected={activeSelectedId === task.draftId}
                  onOpen={onOpen}
                  onStop={onStop}
                  onDismiss={onDismiss}
                />
              ))}
            </ul>
          )}
        </div>
      </section>
    </div>
  )
}

function FilterPill({
  label,
  value,
  tone,
  active,
  onClick,
}: {
  label: string
  value: number
  tone: Tone
  active: boolean
  onClick: () => void
}) {
  const palette = tonePalette(tone)
  const style: React.CSSProperties = active
    ? { background: palette.bgSoft, color: palette.textStrong }
    : { background: 'transparent', color: 'var(--text-secondary)' }
  return (
    <button
      type="button"
      role="tab"
      aria-pressed={active}
      onClick={onClick}
      className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors hover:bg-white/[0.04]"
      style={style}
    >
      <span className="font-semibold tabular-nums">{value}</span>
      <span>{label}</span>
    </button>
  )
}

function TaskRow({
  task,
  selected,
  onOpen,
  onStop,
  onDismiss,
}: {
  task: DraftRecord
  selected: boolean
  onOpen: (draftId: string) => void
  onStop: (draftId: string) => void
  onDismiss: (draftId: string) => void
}) {
  const active = isActiveWizardTask(task.status)
  const stale = active && isPossiblyStale(task)
  const hasError = Boolean(task.errorMessage)
  return (
    <li
      className="flex items-center gap-1 rounded-md transition-colors hover:bg-white/[0.03]"
      style={{
        background: selected ? 'var(--bg-selected)' : 'transparent',
      }}
      aria-current={selected ? 'true' : undefined}
    >
      <button
        type="button"
        onClick={() => onOpen(task.draftId)}
        className="min-w-0 flex-1 rounded-md px-3 py-2 text-left"
      >
        <span className="flex min-w-0 items-center gap-2">
          <StatusDot state={dotStateForDraft(task.status)} />
          <span className="min-w-0 truncate text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>
            {taskTitle(task)}
          </span>
          <StatusChip status={task.status} />
        </span>
        <span className="mt-1 flex min-w-0 items-center gap-2 truncate text-[11px]" style={{ color: 'var(--text-muted)' }}>
          <span className="truncate">{stageLabel(task)}</span>
          {task.wizardAgent && (
            <>
              <Sep />
              <span className="font-mono text-[10px] uppercase tracking-wide">{task.wizardAgent}</span>
            </>
          )}
          <Sep />
          <span className="tabular-nums" title={task.updatedAt}>
            {relativeOrTime(task.updatedAt)}
          </span>
          {hasError && (
            <>
              <Sep />
              <span
                className="inline-flex min-w-0 items-center gap-1 truncate"
                style={{ color: 'rgb(251, 113, 133)' }}
                title={task.errorMessage}
              >
                <WarnIcon />
                <span className="truncate">{task.errorMessage}</span>
              </span>
            </>
          )}
          {stale && !hasError && (
            <>
              <Sep />
              <span className="inline-flex items-center gap-1" style={{ color: 'rgb(251, 191, 36)' }} title="No recent update; reopen to inspect progress.">
                <WarnIcon />
                <span>stalled</span>
              </span>
            </>
          )}
        </span>
      </button>
      <div className="flex shrink-0 items-center gap-0.5 pr-1.5">
        {active ? (
          <IconButton
            label={`Stop wizard task ${taskTitle(task)}`}
            title="Stop generation"
            onClick={() => onStop(task.draftId)}
            tone="danger"
          >
            <StopIcon />
          </IconButton>
        ) : (
          <IconButton
            label={`Remove wizard task ${taskTitle(task)}`}
            title="Dismiss"
            onClick={() => onDismiss(task.draftId)}
            tone="muted"
          >
            <CloseIcon />
          </IconButton>
        )}
      </div>
    </li>
  )
}

function IconButton({
  label,
  title,
  onClick,
  tone,
  children,
}: {
  label: string
  title: string
  onClick: () => void
  tone: 'danger' | 'muted'
  children: React.ReactNode
}) {
  const isDanger = tone === 'danger'
  return (
    <button
      type="button"
      aria-label={label}
      title={title}
      onClick={onClick}
      className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors ${
        isDanger
          ? 'text-rose-500 hover:bg-rose-500/15 hover:text-rose-400'
          : 'hover:bg-rose-500/15 hover:text-rose-400'
      }`}
      style={{ color: isDanger ? 'rgb(251, 113, 133)' : 'var(--text-muted)' }}
    >
      {children}
    </button>
  )
}

function StatusChip({ status }: { status: DraftRecord['status'] }) {
  const palette = statusChipPalette(status)
  return (
    <span
      className="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
      style={{ background: palette.bg, color: palette.text }}
    >
      {compactStatusLabelFromStatus(status)}
    </span>
  )
}

function Sep() {
  return (
    <span aria-hidden="true" className="select-none" style={{ color: 'var(--text-muted)', opacity: 0.5 }}>
      ·
    </span>
  )
}

function EmptyState({ filter, totalTasks }: { filter: FilterKey | null; totalTasks: number }) {
  const message = totalTasks === 0
    ? 'No wizard tasks yet.'
    : filter === 'running' ? 'No running tasks.'
    : filter === 'ready' ? 'No tasks awaiting review.'
    : filter === 'failed' ? 'No failed tasks.'
    : filter === 'created' ? 'No saved drafts.'
    : 'No tasks match this filter.'
  return (
    <div
      className="flex h-full min-h-[160px] items-center justify-center px-6 py-10 text-center text-[12px]"
      style={{ color: 'var(--text-muted)' }}
    >
      {message}
    </div>
  )
}

function taskCounts(tasks: DraftRecord[]): { running: number; ready: number; failed: number; created: number } {
  return tasks.reduce((acc, task) => {
    if (isActiveWizardTask(task.status)) acc.running += 1
    else if (task.status === 'plan-ready' || task.status === 'spec-ready') acc.ready += 1
    else if (task.status === 'error') acc.failed += 1
    else if (task.status === 'created') acc.created += 1
    return acc
  }, { running: 0, ready: 0, failed: 0, created: 0 })
}

function filterMatches(task: DraftRecord, key: FilterKey): boolean {
  if (key === 'running') return isActiveWizardTask(task.status)
  if (key === 'ready') return task.status === 'plan-ready' || task.status === 'spec-ready'
  if (key === 'failed') return task.status === 'error'
  if (key === 'created') return task.status === 'created'
  return true
}

function tonePalette(tone: Tone): { textStrong: string; bgSoft: string } {
  if (tone === 'running') return { textStrong: 'rgb(56, 189, 248)', bgSoft: 'rgba(14, 165, 233, 0.15)' }
  if (tone === 'ready') return { textStrong: 'rgb(52, 211, 153)', bgSoft: 'rgba(16, 185, 129, 0.15)' }
  if (tone === 'failed') return { textStrong: 'rgb(251, 113, 133)', bgSoft: 'rgba(244, 63, 94, 0.15)' }
  if (tone === 'idle') return { textStrong: 'var(--text-primary)', bgSoft: 'var(--bg-selected)' }
  return { textStrong: 'var(--text-primary)', bgSoft: 'var(--bg-selected)' }
}

function statusChipPalette(status: DraftRecord['status']): { bg: string; text: string } {
  if (status === 'plan-ready' || status === 'spec-ready' || status === 'accepted') {
    return { bg: 'rgba(16, 185, 129, 0.15)', text: 'rgb(52, 211, 153)' }
  }
  if (status === 'error') {
    return { bg: 'rgba(244, 63, 94, 0.15)', text: 'rgb(251, 113, 133)' }
  }
  if (status === 'cancelled' || status === 'rejected') {
    return { bg: 'rgba(245, 158, 11, 0.15)', text: 'rgb(251, 191, 36)' }
  }
  if (status === 'created') {
    return { bg: 'var(--bg-selected)', text: 'var(--text-secondary)' }
  }
  return { bg: 'rgba(14, 165, 233, 0.15)', text: 'rgb(56, 189, 248)' }
}

function statusLabel(task: DraftRecord): string {
  if (task.status === 'planning') return 'Wizard planning'
  if (task.status === 'generating') return 'Wizard generating spec'
  if (task.status === 'plan-ready') return 'Wizard plan ready'
  if (task.status === 'spec-ready') return 'Wizard spec ready'
  if (task.status === 'error') return 'Wizard failed'
  if (task.status === 'cancelled') return 'Wizard stopped'
  if (task.status === 'rejected') return 'Wizard rejected'
  return 'Wizard task'
}

function compactStatusLabel(task: DraftRecord): string {
  return compactStatusLabelFromStatus(task.status)
}

function compactStatusLabelFromStatus(status: DraftRecord['status']): string {
  if (status === 'planning') return 'Planning'
  if (status === 'generating') return 'Generating'
  if (status === 'plan-ready') return 'Plan ready'
  if (status === 'spec-ready') return 'Spec ready'
  if (status === 'error') return 'Failed'
  if (status === 'cancelled') return 'Stopped'
  if (status === 'rejected') return 'Rejected'
  if (status === 'created') return 'Draft'
  return 'Wizard'
}

function taskTitle(task: DraftRecord): string {
  return task.featureName?.trim() || slugifyFeatureName(task.prdText) || task.draftId
}

function stageLabel(task: DraftRecord): string {
  if (task.activeAgentStage === 'planning' || task.status === 'planning') return 'Plan stage'
  if (task.activeAgentStage === 'generating' || task.status === 'generating') return 'Spec stage'
  if (task.status === 'plan-ready') return 'Plan review'
  if (task.status === 'spec-ready') return 'Spec review'
  if (task.status === 'created') return 'Draft'
  return '—'
}

function relativeOrTime(iso: string): string {
  const date = new Date(iso)
  const time = date.getTime()
  if (Number.isNaN(time)) return iso
  const delta = Date.now() - time
  if (delta < 0) return formatClock(date)
  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour
  if (delta < 30_000) return 'just now'
  if (delta < hour) return `${Math.max(1, Math.floor(delta / minute))}m ago`
  if (delta < day) return `${Math.floor(delta / hour)}h ago`
  return formatClock(date)
}

function formatClock(date: Date): string {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function isPossiblyStale(task: DraftRecord): boolean {
  const updated = Date.parse(task.updatedAt)
  if (Number.isNaN(updated)) return false
  return Date.now() - updated > 10 * 60 * 1000
}

function StopIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <rect x="6" y="6" width="12" height="12" rx="1.5" />
    </svg>
  )
}

function WarnIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
    </svg>
  )
}
