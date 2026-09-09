import { useLayoutEffect, useRef, useState } from 'react'
import type { DirtySpecSummary } from '@/shared/api/types'
import type { PredicateChangeKind, StrengthVerdict, TestChange } from '@shared/verification-strength/types'
import { ComparisonLegend, ComparisonTable, type ComparisonRow } from '@/shared/ui/ComparisonTable'
import { Chip } from '@/shared/ui/StatusChip'
import { SPEC_TONE, specTone, type SpecEditTone } from '../utils/spec-integrity'

export function SpecToneChip({ tone }: { tone: SpecEditTone }) {
  const style = SPEC_TONE[tone]
  return <Chip chrome="border" tone={style.color} icon={<span aria-hidden="true">{style.glyph}</span>} label={tone === 'weaker' ? `${style.label} · hint` : style.label} title={style.title} testId={`dirty-review-tone-${tone}`} />
}

type Assessment = StrengthVerdict | 'unavailable'
const ASSESSMENTS: Record<Assessment, { label: string; rank: number; className: string }> = {
  weaker: { label: 'Weaker · hint', rank: 0, className: 'text-danger' },
  unclassifiable: { label: 'Cannot classify', rank: 1, className: 'text-warning' },
  unavailable: { label: 'Unavailable', rank: 2, className: 'text-secondary' },
  equivalent: { label: 'Equivalent · hint', rank: 3, className: 'text-secondary' },
  stronger: { label: 'Stronger · hint', rank: 4, className: 'text-success' },
}

function AssessmentLabel({ value }: { value: Assessment }) {
  return <span className={`text-[11px] ${ASSESSMENTS[value].className}`} data-assessment={value}>{ASSESSMENTS[value].label}</span>
}

export interface ReviewScrollPosition { top: number; left: number }
type ReviewRow = ComparisonRow & { assessmentValue: Assessment }
type ReviewTest = TestChange & { requirements?: string[] }

export function SpecChangeReview({ spec, error, initialScrollPosition, onScrollPosition }: {
  spec?: DirtySpecSummary
  error?: string | null
  initialScrollPosition: ReviewScrollPosition
  onScrollPosition: (position: ReviewScrollPosition) => void
}) {
  const [filter, setFilter] = useState('all')
  const [initialPosition] = useState(initialScrollPosition)
  const scrollRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = initialPosition.top
      scrollRef.current.scrollLeft = initialPosition.left
    }
  }, [initialPosition])
  const strength = spec?.strength
  const baseline = strength ? strength.baseline === 'run-start' ? 'Run start' : 'Committed' : 'Unavailable'
  const groups: ReviewRow[][] = strength ? [
    ...(strength.reasons ?? []).map((reason, index) => [{ id: `reason-${index}`, kind: 'message' as const, label: 'File', assessmentValue: 'unclassifiable' as const, assessment: <AssessmentLabel value="unclassifiable" />, message: `Cannot classify: ${reason}` }]),
    ...strength.tests.map(testRows),
  ] : (spec?.affectedTests ?? []).map((name) => [{ id: 'unavailable', kind: 'message', label: 'Changed', assessmentValue: 'unavailable', assessment: <AssessmentLabel value="unavailable" />, message: <><p className="font-medium">{name}</p><p className="mt-1 text-secondary">Before and after source unavailable. Review this file in your editor.</p></> }])
  // Sort whole test groups by their worst row, then filter individual rows using
  // their own assessment. File-level hints never overwrite assertion evidence.
  const visible = groups.map((group, index) => ({ group, index, rank: Math.min(...group.map((row) => ASSESSMENTS[row.assessmentValue].rank)) }))
    .sort((a, b) => a.rank - b.rank)
    .flatMap(({ group, index }) => {
      const content = group.filter((row) => row.kind !== 'section' && (filter === 'all' || row.assessmentValue === filter))
        .sort((a, b) => ASSESSMENTS[a.assessmentValue].rank - ASSESSMENTS[b.assessmentValue].rank)
      return content.length ? [...group.filter((row) => row.kind === 'section'), ...content].map((row) => ({ ...row, id: `${index}:${row.id}` })) : []
    })
  const emptyMessage = !spec ? error ?? 'Loading changed test files…' : filter !== 'all' ? 'No changes match this assessment. Choose All assessments to see every change.' : 'No per-test comparison is available. Review the changed file in your editor.'
  const rows: ComparisonRow[] = visible.length ? visible : [{ id: 'empty', kind: 'message', label: !spec && !error ? 'Loading' : 'Comparison', assessment: spec && filter !== 'all' ? '—' : <AssessmentLabel value="unavailable" />, message: <p role={error ? 'alert' : undefined}>{emptyMessage}</p> }]
  return <>
    <div className="cl-review-toolbar">
      <div className="cl-review-file-heading">
        <h3 className="min-w-0 flex-1 truncate font-mono text-xs font-medium" title={spec?.file}>{spec?.file ?? 'Changed test files'}</h3>
        {spec && <SpecToneChip tone={specTone(spec)} />}
        <span className="shrink-0 text-[11px] text-secondary">vs {baseline.toLowerCase()}</span>
      </div>
      <div className="cl-review-table-controls">
        <ComparisonLegend />
        <label className="flex shrink-0 items-center gap-2 text-[11px] text-secondary">Assessment
          <select className="cl-input w-40 px-2 py-1 text-xs" aria-label="Filter by assessment" value={filter} disabled={!spec} onChange={(event) => {
            setFilter(event.target.value)
            if (scrollRef.current) scrollRef.current.scrollTop = 0
            onScrollPosition({ top: 0, left: scrollRef.current?.scrollLeft ?? 0 })
          }}>
            <option value="all">All assessments</option>
            {Object.entries(ASSESSMENTS).map(([value, item]) => <option key={value} value={value}>{item.label}</option>)}
          </select>
        </label>
      </div>
    </div>
    <ComparisonTable rows={rows} review beforeLabel={`Before · ${baseline}`} afterLabel="After · Current test" ariaLabel="Test changes" scrollRef={scrollRef} onScroll={(event) => onScrollPosition({ top: event.currentTarget.scrollTop, left: event.currentTarget.scrollLeft })} />
  </>
}

const TEST_KIND_LABEL: Record<TestChange['kind'], string> = {
  changed: 'Changed', added: 'Added', deleted: 'Deleted', renamed: 'Renamed', disabled: 'Disabled — enforces nothing', enabled: 'Enabled',
}

const PREDICATE_KIND_LABEL: Record<PredicateChangeKind, string> = {
  removed: 'Removed', added: 'Added', retargeted: 'Target changed', reshaped: 'Assertion changed',
  unreadable: 'Unreadable', guarded: 'Guard added', unguarded: 'Guard removed',
}

function testRows(test: ReviewTest): ReviewRow[] {
  const rows: ReviewRow[] = []
  const assessment = { assessmentValue: test.verdict, assessment: <AssessmentLabel value={test.verdict} /> }
  const metadata = <div className="flex flex-wrap items-center gap-2 text-[11px] text-secondary">
    <span>{TEST_KIND_LABEL[test.kind]}</span>
    {(test.requirements ?? []).map((id) => <span key={id} className="rounded bg-selected px-1.5 py-0.5 font-mono text-[10px]">@{id}</span>)}
  </div>
  const renameOnly = test.kind === 'renamed' && test.wasNamed != null && test.changes.length === 0
  if (!renameOnly) rows.push({ id: 'test', kind: 'section', label: <div data-testid="dirty-review-test">
    {metadata}
    <h4 className="mt-1 whitespace-pre-wrap break-words text-[13px] font-semibold leading-relaxed text-primary">{test.name}</h4>
    {test.reason && <p className="mt-1 whitespace-pre-wrap break-words text-xs font-normal leading-relaxed text-secondary">{test.reason}</p>}
  </div>, ...assessment })
  if (test.kind === 'renamed' && test.wasNamed != null) rows.push({ id: 'name', label: renameOnly ? metadata : 'Test name', description: renameOnly ? test.reason : undefined, before: test.wasNamed, after: test.name, ...assessment })
  if (test.kind === 'added' || test.kind === 'deleted') rows.push({ id: 'name', label: 'Test', before: test.kind === 'added' ? null : test.name, after: test.kind === 'deleted' ? null : test.name, ...assessment })
  if (test.kind === 'disabled' || test.kind === 'enabled') rows.push({ id: 'execution', label: 'Execution', before: test.kind === 'disabled' ? 'Enabled' : 'Disabled', after: test.kind === 'disabled' ? 'Disabled' : 'Enabled', ...assessment })
  rows.push(...test.changes.map((change, index) => ({
    id: `change-${index}`,
    label: PREDICATE_KIND_LABEL[change.kind],
    description: change.reason && <>{change.verdict === 'unclassifiable' ? 'Cannot classify: ' : ''}{change.reason}</>,
    before: change.before?.source ?? null,
    after: change.after?.source ?? null,
    assessmentValue: change.verdict,
    assessment: <AssessmentLabel value={change.verdict} />,
    code: true,
    testId: 'dirty-review-change',
  })))
  if (!rows.some((row) => row.kind !== 'section')) rows.push({ id: 'unavailable', kind: 'message', label: TEST_KIND_LABEL[test.kind], message: 'Before and after source unavailable. Review this file in your editor.', ...assessment })
  return rows
}
