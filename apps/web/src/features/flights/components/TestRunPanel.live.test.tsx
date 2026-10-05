// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { RunDetail } from '@shared/run-detail'
import { runIndexEntry } from '@shared/run-index'
import * as runsApi from '@/shared/api/runs'
import { RunsProvider, useRuns } from '@/features/runs/state/RunsContext'
import { featureTestRuns } from '@/shared/lib/feature-test-runs'
import { TestRunPanel } from './TestRunPanel'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
vi.mock('@/shared/api/runs', async (original) => ({ ...await original<typeof import('@/shared/api/runs')>(), listRuns: vi.fn(), getRunDetail: vi.fn() }))
class Socket {
  static instances: Socket[] = []
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  readyState = 0
  constructor() { Socket.instances.push(this) }
  close() { this.readyState = 3 }
}
const record = (id: string, startedAt: string, status: RunDetail['manifest']['status'] = 'passed', executionType: RunDetail['manifest']['executionType'] = 'run'): RunDetail => ({
  runId: id,
  manifest: { runId: id, feature: 'checkout', status, executionType, env: 'staging', startedAt, services: [], healCycles: 0 },
  summary: { complete: true, total: 4, passed: 4, failed: [] },
  playbackEvents: [], playwrightArtifacts: [], lifecycleEvents: [],
})
let container: HTMLDivElement
let root: Root
const open = vi.fn()
const review = vi.fn()
function Panel({ feature = 'checkout' }: { feature?: string }) {
  const store = useRuns({ reconcile: true })
  const runs = featureTestRuns(store.runs, feature)
  return <TestRunPanel feature={feature} featureRuns={runs} runId={runs[0]?.runId} connection={store.connection}
    indexLoaded={store.indexLoaded} indexError={store.indexError} live={false} evidence={{}} awaiting="idle" onOpenRun={open} onOpenSpecReview={review} />
}
async function mount(feature = 'checkout') {
  await act(async () => root.render(<RunsProvider WebSocketImpl={Socket as unknown as typeof WebSocket}><Panel feature={feature} /></RunsProvider>))
}
async function frame(data: unknown) { await act(async () => Socket.instances.at(-1)!.onmessage?.({ data: JSON.stringify(data) })) }
const hero = () => container.querySelector('[data-testid="test-run-hero"]')!
beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  Socket.instances = []
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
  vi.mocked(runsApi.listRuns).mockResolvedValue([])
  vi.mocked(runsApi.getRunDetail).mockRejectedValue(new Error('not loaded'))
})
afterEach(() => { act(() => root.unmount()); container.remove(); vi.useRealTimers() })

it('replaces a historical run with a standalone Verify and keeps every link on the displayed identity', async () => {
  const old = record('run-old', '2026-01-01T00:00:00Z')
  const latest = record('run-new', '2026-01-02T00:00:00Z', 'passed', 'verify')
  latest.manifest.suiteSnapshot = { kind: 'taken', dir: '/workspace/suite', takenAt: latest.manifest.startedAt, digest: 'abc123' }
  latest.manifest.specEdits = { checkedAt: latest.manifest.startedAt, pending: [{ file: 'e2e/a.spec.ts', change: 'modified', affectedTests: [] }], adopted: [] }
  await mount()
  await frame({ type: 'snapshot', runs: [runIndexEntry(old.manifest)], details: { [old.runId]: old } })
  expect(hero().textContent).toContain('Run old')
  await frame({ type: 'update', runId: latest.runId, detail: latest })
  expect(hero().textContent).toContain('Verify new')
  expect(hero().textContent).toContain('staging')
  expect(hero().textContent).toContain('4/4')
  expect(hero().textContent).toContain('recorded unexecuted test-file change')
  expect(hero().querySelector('[data-testid="run-pending-edits"]')).toBeNull()
  expect(container.querySelector('[data-testid="previous-runs"]')?.textContent).toContain('Run old')
  expect(container.querySelector('[data-testid="previous-runs"]')?.textContent).not.toContain('Verify new')
  act(() => hero().querySelector<HTMLButtonElement>('[data-testid="run-hero-spec-edits"]')!.click())
  expect(review).toHaveBeenCalledExactlyOnceWith('checkout', latest.runId)
  act(() => hero().querySelector('button')!.click())
  expect(open).toHaveBeenCalledExactlyOnceWith('checkout', latest.runId)
  await mount('other-suite')
  expect(hero().textContent).toContain('No test runs yet')
})

it('does not invent results while detail is missing, and recovers a missed new-run event within 15 seconds', async () => {
  await mount()
  await act(async () => Socket.instances[0].onopen?.())
  const latest = record('run-recovered', '2026-01-03T00:00:00Z', 'running')
  vi.mocked(runsApi.listRuns).mockResolvedValue([runIndexEntry(latest.manifest)])
  await act(async () => vi.advanceTimersByTimeAsync(15_000))
  expect(hero().textContent).toContain('Run recovered')
  expect(hero().textContent).not.toContain('4/4')
  expect(hero().textContent).toContain('details are loading')
  latest.manifest.status = 'passed'
  await frame({ type: 'update', runId: latest.runId, detail: latest })
  expect(hero().textContent).toContain('4/4')
  expect(hero().textContent).not.toContain('Stop run')
})

it('distinguishes connecting, confirmed empty, and failed reads and automatically recovers', async () => {
  let resolve!: (runs: never[]) => void
  vi.mocked(runsApi.listRuns).mockReturnValue(new Promise((done) => { resolve = done }))
  await mount()
  expect(hero().querySelector('[data-testid="test-run-hero-skeleton"]')).not.toBeNull()
  await act(async () => resolve([]))
  expect(hero().textContent).toContain('No test runs yet')
  vi.mocked(runsApi.listRuns).mockRejectedValue(new Error('read failed'))
  await act(async () => vi.advanceTimersByTimeAsync(15_000))
  expect(hero().textContent).toContain('Run history unavailable')
  expect(container.textContent).toContain('read failed')
  vi.mocked(runsApi.listRuns).mockResolvedValue([])
  await act(async () => vi.advanceTimersByTimeAsync(15_000))
  expect(hero().textContent).toContain('No test runs yet')
})

it('a stream update supersedes a late index response and reconnect requests a fresh index', async () => {
  let resolve!: (runs: never[]) => void
  vi.mocked(runsApi.listRuns).mockReturnValue(new Promise((done) => { resolve = done }))
  await mount()
  await act(async () => Socket.instances[0].onopen?.())
  const latest = record('run-stream', '2026-01-02T00:00:00Z')
  await frame({ type: 'snapshot', runs: [runIndexEntry(latest.manifest)], details: { [latest.runId]: latest } })
  await act(async () => resolve([]))
  expect(hero().textContent).toContain('Run stream')
  vi.mocked(runsApi.listRuns).mockResolvedValue([])
  await act(async () => Socket.instances[0].onclose?.())
  expect(container.textContent).toContain('out of date')
  await act(async () => vi.advanceTimersByTimeAsync(500))
  await act(async () => Socket.instances.at(-1)!.onopen?.())
  expect(hero().textContent).toContain('No test runs yet')
})
