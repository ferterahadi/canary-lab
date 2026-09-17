// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '@/shared/api/client'
import { InvalidationProvider, useInvalidation } from '@/shared/state/invalidation'
import { COVERAGE_FRESHNESS_LEASE_MS, COVERAGE_RECONCILE_MS } from '@shared/coverage/freshness'
import { CoverageLedgerPage } from './CoverageLedgerPage'
import { LEDGER } from './__fixtures__/CoverageLedgerPage.part2-fixtures'

vi.mock('@/shared/api/client', async (load) => ({
  ...await load<typeof api>(), getFeatureCoverage: vi.fn(), listFeatureDocs: vi.fn(),
}))
let host: HTMLDivElement
let root: Root
const fresh = () => ({ ...structuredClone(LEDGER), freshness: { ...LEDGER.freshness!, state: 'current' as const, reasons: [], nextAction: undefined }, state: { ...LEDGER.state!, summary: 'fresh' as const, coverage: 'fresh' as const, headline: 'Covered 33%' } })
beforeEach(() => {
  vi.useFakeTimers()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  vi.mocked(api.getFeatureCoverage).mockResolvedValue(fresh())
  vi.mocked(api.listFeatureDocs).mockResolvedValue({ feature: 'checkout', docs: [], hasPrdSummary: true, sourceDocCount: 1, docsDrift: false })
})
afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers(); vi.resetAllMocks() })
const text = (id: string) => host.querySelector(`[data-testid="${id}"]`)?.textContent
const mount = async (onOpenRecovery = vi.fn()) => {
  function View() {
    const { invalidate } = useInvalidation()
    return <><button data-testid="change" onClick={() => invalidate('coverage')}>Change</button><CoverageLedgerPage feature="checkout" onClose={() => {}} onOpenGeneration={() => {}} onOpenRecovery={onOpenRecovery} /></>
  }
  await act(async () => root.render(<InvalidationProvider><View /></InvalidationProvider>))
}

describe('an already-open coverage page', () => {
  it('withdraws a green headline, updates its test count, and opens the necessary Flight stage without refreshing', async () => {
    const recover = vi.fn()
    await mount(recover)
    expect(text('coverage-pct')).toBe('33%')
    const stale = structuredClone(LEDGER)
    stale.tests.push({ name: 'new test', requirements: [], pathTypes: [], strength: 'shallow' })
    vi.mocked(api.getFeatureCoverage).mockResolvedValue(stale)
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="change"]')!.click())
    expect(text('coverage-pct')).toBe('—')
    expect(text('coverage-sentence')).toContain('historical')
    expect(host.textContent).toContain('new test')
    const button = host.querySelector<HTMLButtonElement>('[data-testid="coverage-freshness-notice"] button')!
    await act(async () => button.click())
    expect(recover).toHaveBeenCalledWith('prd-summary')
  })

  it('recovers dropped events through reconciliation and exposes a newer failed result', async () => {
    await mount()
    const failed = fresh()
    failed.provenRunId = 'new-failure'
    failed.tests[0].lastRun = { runId: 'new-failure', passed: false }
    failed.freshness.latestRunFailed = true
    vi.mocked(api.getFeatureCoverage).mockResolvedValue(failed)
    await act(async () => vi.advanceTimersByTimeAsync(COVERAGE_RECONCILE_MS))
    expect(text('coverage-freshness-notice')).toContain('Latest run has failures')
    expect(text('coverage-latest-run')).toContain('1 failed')
  })

  it('keeps previous figures explicitly historical on errors, expires hung reads, and recovers automatically', async () => {
    await mount()
    vi.mocked(api.getFeatureCoverage).mockRejectedValue(new Error('offline'))
    await act(async () => vi.advanceTimersByTimeAsync(COVERAGE_RECONCILE_MS))
    expect(text('coverage-pct')).toBe('—')
    expect(text('coverage-sentence')).toContain('historical')
    vi.mocked(api.getFeatureCoverage).mockResolvedValue(fresh())
    await act(async () => window.dispatchEvent(new Event('online')))
    expect(text('coverage-pct')).toBe('33%')
    vi.mocked(api.getFeatureCoverage).mockImplementation(() => new Promise(() => {}))
    await act(async () => vi.advanceTimersByTimeAsync(COVERAGE_FRESHNESS_LEASE_MS + 1))
    expect(text('coverage-pct')).toBe('—')
  })

  it('ignores a delayed old response after a newer change has been rendered', async () => {
    let old!: (value: ReturnType<typeof fresh>) => void
    vi.mocked(api.getFeatureCoverage).mockImplementationOnce(() => new Promise((resolve) => { old = resolve }))
    await mount()
    vi.mocked(api.getFeatureCoverage).mockResolvedValue(structuredClone(LEDGER))
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="change"]')!.click())
    await act(async () => old(fresh()))
    expect(text('coverage-pct')).toBe('—')
    expect(text('coverage-freshness-notice')).toContain('Coverage out of date')
  })
})
