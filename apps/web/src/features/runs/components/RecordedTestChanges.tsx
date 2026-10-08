import type { RunManifest } from '@shared/run-manifest'
import { isTerminalRunStatus } from '@shared/run-state'
import { formatLifecycleDate } from './RunDiagnosticsPanels'
import { shortTime } from '@/shared/lib/format'

export function RecordedTestChanges({ manifest, onCompare }: { manifest: RunManifest; onCompare?: () => void }) {
  const edits = manifest.specEdits
  if (!isTerminalRunStatus(manifest.status) || !edits?.pending.length) return null
  return (
    <section className="cl-card mt-3" data-testid="recorded-test-changes">
      <div className="cl-card-head"><h2 className="cl-rubric">Recorded test changes</h2></div>
      <div className="cl-card-body text-xs">
        <p className="m-0 text-secondary">This run recorded test changes it did not execute. These are historical records, not a current outstanding-review count. Its saved result remains unchanged.</p>
        <p className="mt-2 text-muted">Last checked: <time dateTime={edits.checkedAt}>{formatLifecycleDate(edits.checkedAt)} {shortTime(edits.checkedAt)}</time></p>
        <ul className="my-2 space-y-2 pl-4">
          {edits.pending.map((edit) => <li key={edit.file}>
            <span className="font-mono">{edit.file}</span> <span className="text-muted">({edit.change})</span>
            {edit.affectedTests.length > 0 && <ul className="mt-1 pl-4 text-secondary">{edit.affectedTests.map((test) => <li key={test}>{test}</li>)}</ul>}
          </li>)}
        </ul>
        {onCompare && <button type="button" className="cl-button px-3 py-1.5" onClick={onCompare}>Compare with current tests →</button>}
      </div>
    </section>
  )
}
