import { restartRun } from '@/shared/api/runs'
import { useEffect, useState } from 'react'
import type { RunDetail } from '@shared/run-detail'
import { getFeatureTests } from '@/shared/api/config'
import { ToastHost } from '@/shared/ui/Toasts'

export function TestReviewAcceptedToast({ feature, detail, continueRunId, continuationOf, onDismiss, onRun }: {
  continueRunId?: string
  continuationOf?: string
  feature: string
  detail?: RunDetail | null
  onDismiss: () => void
  onRun?: (feature: string, continuationOf?: string, env?: string) => void
}) {
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
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
    id: 'test-review-accepted', title: continueRunId ? 'Accepted — awaiting execution' : 'Changes committed', tone: 'success', actionOnly: true, dismissOnOpen: !continueRunId,
    body: error ?? (continueRunId ? `${current} Continue this run to verify the accepted changes. Earlier results remain recorded.` : `${current} ${historical} Run again to test the latest source.`),
    actionLabel: continueRunId ? busy ? 'Continuing…' : 'Continue run' : onRun ? count === undefined ? 'Run latest tests' : `Run latest ${count} tests` : undefined,
    onClick: continueRunId ? () => {
      if (busy) return
      setBusy(true)
      restartRun(continueRunId).then(onDismiss).catch((failure: Error) => setError(failure.message)).finally(() => setBusy(false))
    } : onRun ? () => continuationOf ? onRun(feature, continuationOf, detail?.manifest.env) : onRun(feature) : undefined,
  }]} onDismiss={onDismiss} />
}
