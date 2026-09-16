import { CopyField } from '../ui/CopyField'
import { StatusDot } from '@/shared/ui/atoms'

/**
 * The one card for "the test list did not load", in both of the column's
 * versions: workspace discovery and a run's recorded roster.
 *
 * One component rather than two, because they are the same failure seen from
 * two sides, and a user who learns the shape once should not have to learn it
 * again. What differs is `repair` — and it differs by ABSENCE, not by a flag.
 * A run's recorded list is evidence of what that run executed; it cannot be
 * regenerated from today's workspace, so the run card is constructed without a
 * repair configuration and there is no branch here that could grow one.
 *
 * The error is the card's main content, not its small print. The first line
 * shows on the card — that is usually the whole diagnosis ("Cannot find module
 * './fixtures/auth'") — and the rest goes in one named disclosure that is
 * absent when there is no rest. Before this, every failure cost a click before
 * it said anything.
 */
export function TestListUnavailableCard({
  title,
  lead,
  error,
  retryLabel,
  onRetry,
  repair,
  testId,
}: {
  title: string
  /** One sentence of cause. Never a restatement of what the buttons do. */
  lead: string
  /** What actually failed, as the server reported it. */
  error: string
  retryLabel: string
  onRetry: () => void
  /** Workspace only — see the note above on why this is an absence. */
  repair?: {
    starting: boolean
    /** A previous repair failed, so the button offers to continue it. */
    resume: boolean
    onStart: () => void
    /** The slash command that does the same thing in the user's own agent. */
    command: string
    /** Why the last attempt to start one failed. It reads as an instruction to
     *  use the command below it, so it renders directly above that field. */
    startError: string | null
  }
  testId?: string
}) {
  const [summary, ...rest] = error.split('\n')
  const hasFullOutput = rest.some((line) => line.trim().length > 0)
  return (
    <div className="cl-card mb-3 p-3 text-xs" data-testid={testId} style={{ color: 'var(--text-secondary)' }}>
      <div role="status">
        <div className="flex items-center gap-2">
          <StatusDot state="failed" />
          <span className="text-[13px] font-medium text-primary">{title}</span>
        </div>
        <p className="mt-1.5 leading-relaxed">{lead}</p>
      </div>
      <p
        data-testid="test-list-error-summary"
        title={summary}
        className="mt-2.5 truncate rounded border px-2 py-1.5 text-[11px]"
        style={{
          fontFamily: 'var(--font-mono)',
          color: 'var(--text-muted)',
          borderColor: 'var(--border-default)',
          background: 'var(--bg-base)',
        }}
      >
        {summary}
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {repair && (
          <button type="button" className="cl-button-primary px-3 py-1.5" disabled={repair.starting} onClick={repair.onStart}>
            {repair.starting ? 'Starting…' : repair.resume ? 'Resume repair' : 'Repair in Canary Lab'}
          </button>
        )}
        <button type="button" className="cl-button px-2 py-1" onClick={onRetry}>{retryLabel}</button>
      </div>
      {repair && (
        // A peer of the buttons, not a drawer item: handing the job to your own
        // agent is the third way out of this state, and it was unfindable while
        // it sat behind a disclosure labelled "Details & other options".
        <div className="mt-3 border-t pt-3" style={{ borderColor: 'var(--border-default)' }}>
          {repair.startError && <p role="alert" className="mb-2 text-danger">{repair.startError}</p>}
          <p style={{ color: 'var(--text-muted)' }}>Rather fix it in your own agent? Paste this into Claude or Codex.</p>
          <CopyField value={repair.command} label="discovery repair command" testId="discovery-repair-command" />
        </div>
      )}
      {hasFullOutput && (
        <details className="mt-3 border-t pt-3" style={{ borderColor: 'var(--border-default)' }}>
          <summary className="cursor-pointer text-muted hover:text-primary">Full error output</summary>
          <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words text-[11px]">{error}</pre>
        </details>
      )}
    </div>
  )
}
