import { useState } from 'react'
import type { DirtySpecSummary } from '@/shared/api/types'
import type { PredicateChange, TestChange } from '@shared/verification-strength/types'
import { Chip } from '@/shared/ui/StatusChip'
import { SPEC_TONE, specTone, type SpecEditTone } from '../utils/spec-integrity'

export function SpecToneChip({ tone }: { tone: SpecEditTone }) {
  const style = SPEC_TONE[tone]
  return <Chip chrome="border" tone={style.color} icon={<span aria-hidden="true">{style.glyph}</span>} label={tone === 'weaker' ? `${style.label} · hint` : style.label} title={style.title} testId={`dirty-review-tone-${tone}`} />
}

function weaker(test: TestChange): boolean {
  return test.verdict === 'weaker' || test.changes.some((change) => change.verdict === 'weaker')
}

export function SpecChangeReview({ spec }: { spec: DirtySpecSummary }) {
  const [othersOpen, setOthersOpen] = useState(false)
  const strength = spec.strength
  const suspected = strength?.tests.filter(weaker) ?? []
  const others = strength?.tests.filter((test) => !weaker(test)) ?? []
  const renamed = others.filter((test) => test.kind === 'renamed').length
  const unclassified = others.filter((test) => test.verdict === 'unclassifiable').length
  return <>
    <div className="mb-4 flex flex-wrap items-center gap-2">
      <h3 className="min-w-0 flex-1 break-words font-mono text-xs font-medium">{spec.file}</h3>
      <SpecToneChip tone={specTone(spec)} />
      {strength && <span className="text-[11px] text-secondary">vs {strength.baseline === 'run-start' ? 'run start' : 'committed'}</span>}
    </div>
    {(strength?.reasons ?? []).map((reason) => <p key={reason} className="mb-3 text-xs text-secondary">Cannot classify: {reason}</p>)}
    {!strength ? <ul className="space-y-2 text-xs text-secondary">{spec.affectedTests.map((test) => <li className="break-words" key={test}>{test}</li>)}</ul> : <>
      {suspected.length > 0 && <>
        <p className="mb-3 text-[11px] font-medium text-danger">Suspected weakening · {suspected.length} {suspected.length === 1 ? 'test' : 'tests'}</p>
        <ul className="space-y-5">{suspected.map((test) => <TestChangeRow key={`${test.kind}:${test.name}`} test={test} />)}</ul>
      </>}
      {others.length > 0 && (suspected.length === 0 ? <ul className="space-y-5">{others.map((test) => <TestChangeRow key={`${test.kind}:${test.name}`} test={test} />)}</ul> : <div className="mt-5 rounded-md border border-line">
        <button className="flex w-full flex-wrap items-center justify-between gap-2 px-3 py-3 text-left text-xs" aria-expanded={othersOpen} onClick={() => setOthersOpen(!othersOpen)}>
          <span>{othersOpen ? '⌄' : '›'} Other changes · {others.length}</span>
          <span className="text-[11px] text-secondary">{[renamed ? `${renamed} renamed` : '', unclassified ? `${unclassified} unclassified` : ''].filter(Boolean).join(' · ')}</span>
        </button>
        {othersOpen && <ul className="space-y-5 border-t border-line p-3">{[...others].sort((a, b) => Number(b.verdict === 'unclassifiable') - Number(a.verdict === 'unclassifiable')).map((test) => <TestChangeRow key={`${test.kind}:${test.name}`} test={test} />)}</ul>}
      </div>)}
      {others.length > 0 && suspected.length > 0 && <p className="mt-2 text-[11px] text-secondary">Other changes still need review. An unclassified result is not evidence that nothing weakened.</p>}
      {!strength.tests.length && <p className="text-xs text-secondary">No per-test comparison is available. Review the changed file in your editor.</p>}
    </>}
  </>
}

const TEST_KIND_LABEL: Record<TestChange['kind'], string> = {
  changed: 'Changed', added: 'Added', deleted: 'Deleted', renamed: 'Renamed', disabled: 'Disabled — enforces nothing', enabled: 'Enabled',
}

function TestChangeRow({ test }: { test: TestChange & { requirements?: string[] } }) {
  return <li className="min-w-0" data-testid="dirty-review-test">
    <div className="flex flex-wrap items-center gap-2 text-[11px] text-secondary">
      <span>{TEST_KIND_LABEL[test.kind]}</span>
      {test.verdict === 'unclassifiable' && <span>Cannot classify</span>}
      {(test.requirements ?? []).map((id) => <span key={id} className="rounded bg-selected px-1.5 py-0.5 font-mono text-[10px]">@{id}</span>)}
    </div>
    <h4 className="mt-2 whitespace-pre-wrap break-words text-[13px] font-semibold leading-relaxed">{test.name}</h4>
    {test.kind === 'renamed' && test.wasNamed && <p className="mt-1 whitespace-pre-wrap break-words text-xs leading-relaxed text-secondary">{test.wasNamed} → {test.name}</p>}
    {test.reason && <p className="mt-2 whitespace-pre-wrap break-words text-xs leading-relaxed text-secondary">{test.reason}</p>}
    {test.changes.length > 0 && <ul className="mt-3 space-y-3">{test.changes.map((change, index) => <ChangeRow key={index} change={change} />)}</ul>}
  </li>
}

function ChangeRow({ change }: { change: PredicateChange }) {
  return <li data-testid="dirty-review-change">
    <p className="mb-2 text-[11px] text-secondary"><span className={change.verdict === 'weaker' ? 'text-danger' : ''}>{change.kind}</span>{change.reason && <> · {change.verdict === 'unclassifiable' ? 'Cannot classify: ' : ''}{change.reason}</>}</p>
    <div className="cl-review-diff">
      <div><p className="cl-review-diff-label">Before · Baseline</p><pre><span className="sr-only">was </span>{change.before?.source ?? '—'}</pre></div>
      <div><p className="cl-review-diff-label">After · Current test</p><pre><span className="sr-only">now </span>{change.after?.source ?? '—'}</pre></div>
    </div>
  </li>
}
