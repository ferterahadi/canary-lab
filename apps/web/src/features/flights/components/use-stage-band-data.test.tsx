// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import type { FlightManifest, FlightStage } from '@shared/flights/types'
import { ApiError } from '@/shared/api/internal'
import { InvalidationProvider, useInvalidation } from '@/shared/state/invalidation'
import { useStageBandData } from './use-stage-band-data'
import { stageFacts, type StageBandData } from './StageFacts'

const mocks = vi.hoisted(() => ({ config: vi.fn(), detail: vi.fn(), runs: vi.fn() }))
vi.mock('@/shared/api/config', () => ({ getFeatureConfigDoc: mocks.config }))
vi.mock('@/shared/api/runs', () => ({ getRunDetail: mocks.detail, listRuns: mocks.runs }))
vi.mock('@/shared/state/use-live-coverage', () => ({ useLiveCoverage: () => ({ value: null, loading: false }) }))
vi.mock('@/features/portify/state/PortifyContext', () => ({ usePortifyDetail: () => ({ manifest: null, loading: false }) }))

let root: Root
let container: HTMLDivElement
let observed: StageBandData
let invalidate: ReturnType<typeof useInvalidation>['invalidate']
let serial = 0
let flight: FlightManifest
const scaffold: FlightStage = { key: 'scaffold', status: 'done' }
const capture = (runId?: string): FlightStage => ({ key: 'env-capture', status: 'done', evidence: runId ? { boot: { runId, services: [] } } : {} })
const config = (local = false) => ({ parsed: { value: { repos: [{ name: 'app', ...(local ? { startCommands: [{ name: 'api', command: 'npm start' }] } : {}) }] } } })
function Harness({ companion }: { companion: FlightStage }) {
  invalidate = useInvalidation().invalidate
  observed = useStageBandData(flight, scaffold, companion, null)
  return <div>{stageFacts(scaffold, flight, companion, observed).map(f => <span key={f.label}>{f.label}: {f.value}</span>)}</div>
}
async function render(companion = capture()) {
  await act(async () => { root.render(<InvalidationProvider><Harness companion={companion} /></InvalidationProvider>) })
}
beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  flight = { feature: `suite-${++serial}`, stages: [], opts: { env: 'staging' } } as unknown as FlightManifest
  mocks.config.mockResolvedValue(config())
  mocks.runs.mockResolvedValue([])
  mocks.detail.mockResolvedValue({ runId: 'ordinary', manifest: { services: [], status: 'passed' } })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
})

it('uses the nested proof reference rather than searching for a dedicated boot run', async () => {
  await render(capture('ordinary'))
  expect(mocks.detail).toHaveBeenCalledWith('ordinary')
  expect(mocks.runs).not.toHaveBeenCalled()
  expect(container.textContent).toContain('Local services: Not required')
})

it('keeps local service proof and never infers no services from an empty run', async () => {
  mocks.config.mockResolvedValue(config(true))
  await render(capture('ordinary'))
  expect(container.textContent).toContain('Services booted:')
  expect(container.textContent).not.toContain('Not required')
  expect(observed.config?.services).toBe(1)
})

it.each([undefined, {}, { repos: null }])('leaves an unsupported config unknown: %j', async value => {
  mocks.config.mockResolvedValue({ parsed: { value } })
  await render()
  expect(observed.config).toBeNull()
  expect(container.textContent).not.toContain('Not required')
})

it('updates the mounted tiles after a configuration event and recovers a missed event within five seconds', async () => {
  await render()
  expect(container.textContent).toContain('Not required')
  mocks.config.mockResolvedValue(config(true))
  await act(async () => invalidate('configuration', flight.feature))
  expect(container.textContent).not.toContain('Not required')
  mocks.config.mockResolvedValue(config())
  await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
  expect(container.textContent).toContain('Not required')
})

it('withdraws stale config on a read failure and automatically recovers', async () => {
  await render()
  mocks.config.mockRejectedValue(new Error('offline'))
  await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
  expect(observed.setupError).toBe('offline')
  expect(container.textContent).not.toContain('Not required')
  mocks.config.mockResolvedValue(config())
  await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
  expect(observed.setupError).toBeNull()
  expect(container.textContent).toContain('Not required')
})

it('keeps cleaned run details absent without losing recorded evidence or inventing a successful run', async () => {
  mocks.detail.mockRejectedValue(new ApiError(404, null))
  await render(capture('removed'))
  expect(observed.boot).toBeNull()
  expect(observed.setupError).toBeNull()
  expect(mocks.runs).not.toHaveBeenCalled()
})

it('refreshes pinned proof while open and retires it on network failure', async () => {
  await render(capture('ordinary'))
  mocks.detail.mockRejectedValue(new Error('connection lost'))
  await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
  expect(observed.boot).toBeNull()
  expect(observed.setupError).toBe('connection lost')
  mocks.detail.mockResolvedValue({ runId: 'ordinary', manifest: { services: [], status: 'passed' } })
  await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
  expect(observed.boot?.runId).toBe('ordinary')
})

it('an old proof response cannot overwrite the newly referenced run', async () => {
  let resolveOld!: (value: unknown) => void
  mocks.detail.mockImplementation((id: string) => id === 'old' ? new Promise(resolve => { resolveOld = resolve })
    : Promise.resolve({ runId: id, manifest: { services: [], status: 'passed' } }))
  await render(capture('old'))
  await render(capture('new'))
  await act(async () => resolveOld({ runId: 'old', manifest: { services: [], status: 'passed' } }))
  expect(observed.boot?.runId).toBe('new')
})

it('follows active capture progress and preserves the legacy boot fallback', async () => {
  await render({ key: 'env-capture', status: 'running', progress: { runId: 'active-boot' } })
  expect(mocks.detail).toHaveBeenCalledWith('active-boot')
  mocks.runs.mockResolvedValue([{ runId: 'legacy-boot', executionType: 'boot', status: 'aborted' }])
  await render(capture())
  expect(mocks.detail).toHaveBeenCalledWith('legacy-boot')
})
