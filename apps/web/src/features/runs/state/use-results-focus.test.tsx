import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import type { RunDetail } from '@shared/run-detail'
import { evidenceKnownTests, stampedEvidencePlaybackEvents } from '@shared/__fixtures__/run-evidence'
import { useResultsFocus, type ResultsFocus } from './use-results-focus'

function Probe({ runId, detail, focus, onResolve }: { runId: string; detail?: RunDetail; focus: ResultsFocus; onResolve: (key: string) => void }) {
  useResultsFocus(runId, detail, focus, onResolve)
  return null
}

const detail: RunDetail = {
  runId: 'run-1',
  manifest: { runId: 'run-1', feature: 'storefront', startedAt: '2026-10-08T10:00:00.000Z', status: 'passed', healCycles: 2, services: [] },
  playbackEvents: stampedEvidencePlaybackEvents(),
  summary: { complete: true, total: 4, passed: 4, failed: [], knownTests: evidenceKnownTests },
}

it('waits for the run detail, resolves each focus once, and resolves a new focus again', () => {
  const root = createRoot(document.createElement('div'))
  const onResolve = vi.fn()
  const discount = { test: 'test-case-applies-the-discount' }
  act(() => root.render(<Probe runId="run-1" focus={discount} onResolve={onResolve} />))
  expect(onResolve).not.toHaveBeenCalled()
  act(() => root.render(<Probe runId="run-1" detail={detail} focus={discount} onResolve={onResolve} />))
  expect(onResolve).toHaveBeenCalledOnce()
  // A pushed update re-renders with a new detail object: the reader is not pulled back.
  act(() => root.render(<Probe runId="run-1" detail={{ ...detail }} focus={discount} onResolve={onResolve} />))
  expect(onResolve).toHaveBeenCalledOnce()
  act(() => root.render(<Probe runId="run-1" detail={detail} focus={{ test: 'test-case-reserves-stock' }} onResolve={onResolve} />))
  expect(onResolve).toHaveBeenCalledTimes(2)
  act(() => root.unmount())
})
