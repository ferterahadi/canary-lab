import type { ReactNode } from 'react'
import { Tooltip } from '../ui/Tooltip'
import { AlertCircleIcon, FileIcon, PlayIcon, StatusDot } from '../ui/atoms'
import { TEST_CHANGE_MARKS, TestChangeMark } from '../ui/TestChangeMark'
import type { useTestVersions } from './use-test-versions'
import { TEST_CHANGE_KINDS } from '../lib/test-versions'
import type { TestChangeKind, VersionTest } from '../lib/test-versions'

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
  onReviewTest?: (file: string, line?: number, baseline?: 'run', change?: TestChangeKind, test?: string) => void
  fallback: ReactNode
}

export function TestsVersionHeader({ currentTests, onCurrentTestsChange, currentTotal, recordedTotal, passed, failed, skipped, running, runId, comparison, onReviewTest, fallback }: Props) {
  const resultLabel = `Recorded run ${runId ?? ''}: ${passed ?? 'unknown'} passed of ${recordedTotal ?? 'unknown'} tests${failed ? `, ${failed} failed` : ''}${skipped ? `, ${skipped} skipped` : ''}${running ? '. Run in progress' : ''}. Results belong to the recorded tests, not current source.`
  const sourceLabel = `Current source: ${currentTotal ?? 'unknown'} tests. No execution results are attached to this view.`
  /* The tab shows one icon and one ratio, so its accessible NAME is the only place
     the failed and skipped counts survive — a count that exists only in a hover
     tooltip is a count a keyboard or screen-reader user does not have. Kept to a
     name rather than the tooltip's full sentence, and opening with the tab's own
     words so it still reads as a name. */
  const sourceName = `Current source: ${currentTotal ?? 'unknown'} tests`
  const resultName = `Recorded run: ${passed ?? 'unknown'} passed of ${recordedTotal ?? 'unknown'} tests${failed ? `, ${failed} failed` : ''}${skipped ? `, ${skipped} skipped` : ''}${running ? ', in progress' : ''}`
  const changes = comparison.state === 'ready' ? comparison.changes : undefined
  /* The header offers no "open the comparison" button: with drift, each mark
     already opens it at the test that drifted, and with no drift there is nothing
     to compare. What the button DID carry that the marks cannot is the difference
     between "nothing changed" and "we could not work out what changed" — so that
     one state keeps a mark of its own. Dropping it would leave an unknown looking
     exactly like a clean comparison. */
  const unknownComparison = comparison.state === 'error' || comparison.state === 'unavailable'
  const unavailable = comparison.state === 'ready' ? 'No test files are available to compare.' : comparison.state === 'loading' ? 'Comparing recorded tests with current source…'
    : comparison.state === 'error' ? 'Could not compare the test versions. Counts of new and changed tests are unknown.'
      : 'Recorded or current source is unavailable. Counts of new and changed tests are unknown.'
  /* Glyph plus numeral, no word and no border: the three counts are one fact —
     how far current source has drifted from the recorded run — and three
     bordered buttons spelling "new/changed/removed" gave that fact more chrome
     and more width than the tabs it qualifies. The word still reaches anyone who
     needs it, through the tooltip and the button's accessible name. */
  const changeMark = (kind: TestChangeKind, tests: VersionTest[]) => {
    const mark = TEST_CHANGE_MARKS[kind]
    const shortExplanation = kind === 'added' ? 'Not in the recorded source.'
      : kind === 'changed' ? 'Only changes inside the test count.'
        : 'Missing from current source.'
    return tests.length > 0 && <TestChangeMark key={kind} kind={kind} count={tests.length}
      tooltip={`${tests.length} ${mark.label} ${tests.length === 1 ? 'test' : 'tests'}. ${shortExplanation}`}
      ariaLabel={`Compare ${tests.length} ${mark.label} tests`}
      onClick={() => onReviewTest?.(tests[0].file, tests[0].line, 'run', kind, tests[0].name)} />
  }
  /* Each tab carries ONE icon naming what it holds — a file, a run — and the run
     icon's COLOUR carries how that run went. A tick or a cross in this slot says
     the verdict but stops saying which tab you are on, so the pair reads as an
     object beside a symbol instead of two of a kind. Hue is the right channel for
     the verdict because the figure beside it already carries the number.
     The exact failed and skipped counts live in `resultLabel`. */
  const runTone = passed === undefined ? 'text-muted' : failed > 0 ? 'text-danger' : 'text-success'
  const runMark = running ? <StatusDot state="running" /> : <span className={runTone}><PlayIcon /></span>

  return <div className="cl-panel-header cl-column-header cl-tests-header">
    <span className="cl-kicker shrink-0">Tests</span>
    {onCurrentTestsChange ? <div role="group" aria-label="Test source" className="cl-tests-tabs">
      <Tooltip label={sourceLabel}>
        <button type="button" aria-label={sourceName} aria-pressed={currentTests} className={`cl-tab${currentTests ? ' cl-tab-active' : ''}`} onClick={() => onCurrentTestsChange(true)}>
          <FileIcon /><span className="cl-tab-count">{currentTotal ?? '—'}</span>
        </button>
      </Tooltip>
      <Tooltip label={resultLabel}>
        <button type="button" aria-label={resultName} aria-pressed={!currentTests} className={`cl-tab${!currentTests ? ' cl-tab-active' : ''}`} onClick={() => onCurrentTestsChange(false)}>
          {runMark}
          <span className="cl-tab-count">{passed ?? '—'}<span className="text-muted">/{recordedTotal ?? '—'}</span></span>
        </button>
      </Tooltip>
    </div> : <div className="flex min-w-0 items-center gap-2">{fallback}</div>}
    {runId && onReviewTest && <div className="cl-test-version-actions">
      {changes && <div className="cl-test-changes">{TEST_CHANGE_KINDS.map((kind) => changeMark(kind, changes[kind]))}</div>}
      {unknownComparison && <Tooltip label={unavailable}>
        <span role="img" tabIndex={0} aria-label={unavailable} data-testid="test-version-compare" className="cl-test-change text-warning">
          <AlertCircleIcon />
        </span>
      </Tooltip>}
    </div>}
  </div>
}
