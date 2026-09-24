import { useEffect, useState } from 'react'
import type { RunDetail } from '@/shared/api/types'
import { getFeatureTests } from '@/shared/api/client'
import { ToastHost } from '@/shared/ui/Toasts'

export function TestReviewAcceptedToast({ feature, detail, onDismiss, onRun }: {
  feature: string
  detail?: RunDetail | null
  onDismiss: () => void
  onRun?: (feature: string) => void
}) {
  const [count, setCount] = useState<number>()
  useEffect(() => {
    let cancelled = false
    getFeatureTests(feature).then((specs) => {
      if (!cancelled && !specs.some((spec) => spec.discoveryError || spec.parseError)) {
        setCount(specs.reduce((total, spec) => total + spec.tests.length, 0))
      }
    }).catch(() => { /* Acceptance succeeded; unavailable counts use generic copy. */ })
    return () => { cancelled = true }
  }, [feature])
  const summary = detail?.summary
  const current = count === undefined ? 'Current source changes are committed.' : `Current source: ${count} tests.`
  const historical = summary ? `The selected ${summary.passed}/${summary.total} run is historical.` : 'The selected run is historical.'
  return <ToastHost toasts={[{
    id: 'test-review-accepted', title: 'Changes committed', tone: 'success', actionOnly: true,
    body: `${current} ${historical} Run again to test the latest source.`,
    actionLabel: onRun ? count === undefined ? 'Run latest tests' : `Run latest ${count} tests` : undefined,
    onClick: onRun ? () => onRun(feature) : undefined,
  }]} onDismiss={onDismiss} />
}
