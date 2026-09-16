import type { ReactNode } from 'react'
import { Tooltip } from '../ui/Tooltip'
import { MinusIcon, PlusIcon, StatusDot } from '../ui/atoms'
import type { useTestVersions } from './use-test-versions'
import type { VersionTest } from '../lib/test-versions'

interface Props {
  currentTests: boolean
  onCurrentTestsChange?: (current: boolean) => void
  currentTotal: number | undefined
  recordedTotal: number | undefined
  passed: number | undefined
  failed: number
  skipped: number
  running: boolean
  runId: string | undefined
  comparison: ReturnType<typeof useTestVersions>['comparison']
  onReviewTest?: (file: string, line?: number, baseline?: 'run') => void
  fallback: ReactNode
}

export function TestsVersionHeader({ currentTests, onCurrentTestsChange, currentTotal, recordedTotal, passed, failed, skipped, running, runId, comparison, onReviewTest, fallback }: Props) {
  const resultLabel = `Recorded run ${runId ?? ''}: ${passed ?? 'unknown'} passed of ${recordedTotal ?? 'unknown'} tests${failed ? `, ${failed} failed` : ''}${skipped ? `, ${skipped} skipped` : ''}${running ? '. Run in progress' : ''}. Results belong to the recorded tests, not current source.`
  const changes = comparison.state === 'ready' ? comparison.changes : undefined
  const compareFile = comparison.state === 'ready' ? comparison.differences[0]?.file ?? comparison.files[0] : undefined
  const unavailable = comparison.state === 'ready' ? 'No test files are available to compare.' : comparison.state === 'loading' ? 'Comparing recorded tests with current source…'
    : comparison.state === 'error' ? 'Could not compare the test versions. Counts of new and changed tests are unknown.'
      : 'Recorded or current source is unavailable. Counts of new and changed tests are unknown.'
  const changeButton = (tests: VersionTest[], label: string, icon: ReactNode) => tests.length > 0 && (
    <Tooltip label={`${tests.length} ${label} since run ${runId}. Open Compare test versions at the first affected test.${label === 'new tests' ? ' New means absent from this recorded source; renames may appear as new and removed.' : ''}`}>
      <button type="button" className="cl-button cl-test-change" style={{ color: label === 'removed tests' ? 'var(--text-secondary)' : 'var(--warning)' }} aria-label={`Compare ${tests.length} ${label}`} onClick={() => onReviewTest?.(tests[0].file, tests[0].line, 'run')}>
        {icon}<span>{tests.length}</span>{label === 'new tests' && <span>new</span>}
      </button>
    </Tooltip>
  )
  return <div className="cl-panel-header cl-column-header cl-tests-header">
    {onCurrentTestsChange && <span className="cl-kicker shrink-0">Tests</span>}
    {onCurrentTestsChange ? <div role="group" aria-label="Test source" className="cl-tests-tabs">
      <Tooltip label={`Current source: ${currentTotal ?? 'unknown'} tests. No execution results are attached to this view.`}>
        <button type="button" aria-label="Current source" aria-pressed={currentTests} className={`cl-tab${currentTests ? ' cl-tab-active' : ''}`} onClick={() => onCurrentTestsChange(true)}>
          Source <span className="cl-count-chip">{currentTotal ?? '—'}</span>
        </button>
      </Tooltip>
      <Tooltip label={resultLabel}>
        <button type="button" aria-label="Recorded run" aria-pressed={!currentTests} className={`cl-tab${!currentTests ? ' cl-tab-active' : ''}`} onClick={() => onCurrentTestsChange(false)}>
          Run {running && <StatusDot state="running" />}
          <span className="font-mono text-[11px] text-success">{passed === undefined ? '—' : `✓${passed}`}<span className="text-muted">/{recordedTotal ?? '—'}</span></span>
          {failed > 0 && <span className="text-danger">×{failed}</span>}
          {skipped > 0 && <span className="text-muted" aria-label={`${skipped} skipped`}>↷{skipped}</span>}
        </button>
      </Tooltip>
    </div> : <div className="flex min-w-0 items-center gap-2"><span className="cl-kicker shrink-0">Tests</span>{fallback}</div>}
    {runId && onReviewTest && <div className="cl-test-version-actions">
      {changes && <>
        {changeButton(changes.added, 'new tests', <PlusIcon />)}
        {changeButton(changes.changed, 'changed tests', <span aria-hidden="true">~</span>)}
        {changeButton(changes.removed, 'removed tests', <MinusIcon />)}
      </>}
      <Tooltip label={compareFile ? 'Compare recorded tests with current source' : unavailable}>
        <button type="button" className="cl-button cl-run-menu-button cl-run-menu-button-compact" aria-label={compareFile ? 'Compare recorded tests with current source' : unavailable}
          aria-disabled={!compareFile} data-testid="test-version-compare" onClick={() => { if (compareFile) onReviewTest(compareFile, undefined, 'run') }}>
          {comparison.state === 'error' || comparison.state === 'unavailable' ? <span aria-hidden="true" className="text-warning">?</span> : <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" aria-hidden="true"><rect x="1.5" y="2" width="13" height="12" rx="1.5" /><path d="M8 2v12" /></svg>}
        </button>
      </Tooltip>
    </div>}
  </div>
}
