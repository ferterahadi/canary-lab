import { useEffect, useState } from 'react'
import * as api from '../api/client'
import type { ExtractedTest, FeatureSpecFile } from '../api/types'
import { colorClassForStatus, statusForTest, type StepStatus } from '../lib/test-step-status'
import type { RunSummary } from '../api/types'
import { ShikiCode, StatusPill, StepBlock } from './shared/TestCodeBlock'

interface Props {
  feature: string | null
  activeRunSummary: RunSummary | undefined
}

export function TestCasesColumn({ feature, activeRunSummary }: Props) {
  const [specs, setSpecs] = useState<FeatureSpecFile[] | null>(null)
  const [expandedTest, setExpandedTest] = useState<string | null>(null)

  useEffect(() => {
    if (!feature) {
      setSpecs(null)
      return
    }
    let cancelled = false
    setSpecs(null)
    setExpandedTest(null)
    api.getFeatureTests(feature)
      .then((data) => {
        if (cancelled) return
        setSpecs(data)
      })
      .catch(() => { /* leave null */ })
    return () => { cancelled = true }
  }, [feature])

  if (!feature) {
    return (
      <div className="flex h-full items-center justify-center text-sm" style={{ color: 'var(--text-muted)' }}>
        Select a feature
      </div>
    )
  }

  const totalTests = specs?.reduce((acc, s) => acc + s.tests.length, 0) ?? 0

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between px-4 py-3" style={{ borderBottom: '1px solid var(--border-default)' }}>
        <div className="flex items-center gap-2">
          <span className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>Tests</span>
        </div>
        {activeRunSummary && (
          <RunningIndicator summary={activeRunSummary} totalTests={totalTests} />
        )}
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin p-3">
        {!specs ? (
          <div className="text-xs" style={{ color: 'var(--text-muted)' }}>Loading...</div>
        ) : specs.length === 0 ? (
          <div className="text-xs" style={{ color: 'var(--text-muted)' }}>No spec files found.</div>
        ) : (
          <div className="space-y-1.5">
            {specs.flatMap((spec) =>
              spec.tests.map((t) => {
                const key = `${spec.file}:${t.line}:${t.name}`
                const isExpanded = expandedTest === key
                return (
                  <TestCard
                    key={key}
                    test={t}
                    status={statusForTest(t.name, activeRunSummary)}
                    expanded={isExpanded}
                    onToggle={() => setExpandedTest(isExpanded ? null : key)}
                  />
                )
              }),
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function TestCard({
  test,
  status,
  expanded,
  onToggle,
}: {
  test: ExtractedTest
  status: StepStatus
  expanded: boolean
  onToggle: () => void
}) {
  return (
    <div
      className={`rounded-lg border transition-all duration-150 ${colorClassForStatus(status)}`}
      style={{ background: expanded ? 'var(--bg-elevated)' : undefined }}
    >
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-3 px-3 py-2.5 text-left"
      >
        <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
          {expanded ? '▾' : '▸'}
        </span>
        <div className="flex-1 min-w-0 truncate text-sm font-medium" title={test.name} style={{ color: 'var(--text-primary)' }}>
          {test.name}
        </div>
        <span className="shrink-0 text-[10px]" style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
          L{test.line}
        </span>
        <StatusPill status={status} />
      </button>
      {expanded && (
        <div className="space-y-2 px-3 pb-3">
          {test.steps.length > 0 ? (
            <ul className="space-y-1.5 pl-3" style={{ borderLeft: '1px solid var(--border-default)' }}>
              {test.steps.map((s, i) => (
                <StepBlock key={`${s.line}:${i}`} step={s} status={status} depth={0} />
              ))}
            </ul>
          ) : test.bodySource ? (
            <ShikiCode source={test.bodySource} />
          ) : (
            <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
              No test body available.
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function RunningIndicator({ summary, totalTests }: { summary: RunSummary; totalTests: number }) {
  // Denominator should reflect the *static* test count parsed from the spec
  // files, not `summary.total` — Playwright's reporter emits a partial total
  // until the suite enumeration completes (especially when filtered/retried),
  // which would briefly read "1/1" while 14 tests are actually queued.
  const total = totalTests > 0 ? totalTests : summary.total
  const done = summary.passed + summary.failed.length
  return (
    <div className="flex items-center gap-2 text-[10px]" style={{ color: 'var(--text-secondary)' }}>
      {!summary.complete && (
        <span className="relative flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-sky-400 opacity-75" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-sky-500" />
        </span>
      )}
      <span style={{ fontFamily: 'var(--font-mono)' }}>{done}/{total}</span>
    </div>
  )
}
