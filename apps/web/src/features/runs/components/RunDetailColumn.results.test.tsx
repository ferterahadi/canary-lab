// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunDetail } from '@shared/run-detail'
import { evidenceKnownTests, stampedEvidenceLifecycleEvents, stampedEvidencePlaybackEvents } from '@shared/__fixtures__/run-evidence'
import { RunDetailColumn } from './RunDetailColumn'

const paneTerminals = vi.hoisted(() => ({ props: [] as Array<{ paneId?: string }>, mounts: [] as string[] }))

vi.mock('../state/RunsContext', () => ({ useRun: vi.fn() }))
vi.mock(import('@/shared/api/runs'), async (importOriginal) => ({
  ...(await importOriginal()),
  listJournal: vi.fn(async () => []),
  getRunCycleReview: vi.fn(async () => ({ iteration: 1, patchPath: '/p', files: [] })),
  getRunServiceExcerpts: vi.fn(async (_runId: string, { execution }: { execution: number }) => ({
    execution,
    excerpts: [{ service: 'web', name: 'Web', execution, source: 'segment' as const, totalLines: 300, matchedBy: 'marker' as const, span: { startLine: 120, endLine: 124, closed: true }, window: { firstLine: 121, lines: ['POST /discount 500'], truncated: false } }],
  })),
  getRunServiceLogLines: vi.fn(async (_runId: string, service: string, { execution, from }: { execution: number; from: number }) => ({
    service, execution, source: 'segment' as const, totalLines: 300, firstLine: from, lines: Array.from({ length: 30 }, (_, i) => `line ${from + i}`), truncated: true,
  })),
}))
vi.mock('@/features/evaluation/state/EvaluationExportContext', () => ({
  useEvaluationExportLog: vi.fn(() => ({ log: '', watchTask: vi.fn() })),
  useEvaluationExportLogs: vi.fn(() => ({})),
  useEvaluationExports: vi.fn(() => ({ startExport: vi.fn(), taskForRun: vi.fn(() => null), taskById: vi.fn(() => null), watchTask: vi.fn(), downloadTask: vi.fn(), logsByTaskId: {} })),
}))
vi.mock('@/shared/shell/McpPromoContext', () => ({ useMcpPromo: () => ({ gatePromo: (_a: string, go: () => void) => go() }) }))
// The journal dialog's own rendering is the shared SourceModal's business.
vi.mock('@/shared/ui/ActivityLogModal', () => ({
  SourceModal: ({ open, title, testId }: { open: boolean; title: string; testId?: string }) => (open ? <div data-testid={testId}>{title}</div> : null),
}))
vi.mock('@/shared/ui/AgentSessionView', () => ({ AgentSessionView: () => <div>agent session</div> }))
vi.mock('./PaneTerminal', async () => {
  const { useEffect } = await import('react')
  return {
    PaneTerminal: (props: { paneId?: string }) => {
      paneTerminals.props.push(props)
      useEffect(() => { paneTerminals.mounts.push(props.paneId ?? '') }, [props.paneId])
      return <div>terminal</div>
    },
  }
})

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  paneTerminals.props = []
  paneTerminals.mounts = []
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
})

async function show(detail: RunDetail, props: Partial<Parameters<typeof RunDetailColumn>[0]> = {}) {
  const { useRun } = await import('../state/RunsContext')
  vi.mocked(useRun).mockReturnValue({ detail, transient: null, status: detail.manifest.status, displayStatus: detail.manifest.status, error: null })
  await act(async () => {
    root.render(<RunDetailColumn runId={detail.runId} {...props} />)
    await Promise.resolve()
  })
}

function tabs(): string[] {
  return [...container.querySelectorAll('header nav button')].map((b) => b.textContent ?? '')
}

function click(label: string): void {
  const target = [...container.querySelectorAll('button')].find((b) => b.textContent === label)
  expect(target, label).toBeTruthy()
  act(() => target!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
}

function detailOf(executionType: 'run' | 'verify' | 'boot' = 'run', runId = 'run-1'): RunDetail {
  return {
    runId,
    manifest: {
      runId, executionType, feature: 'storefront', startedAt: '2026-10-08T10:00:00.000Z', endedAt: '2026-10-08T10:10:00.000Z',
      status: 'passed', healCycles: 2, healMode: 'auto', services: [],
    },
    playbackEvents: stampedEvidencePlaybackEvents(),
    lifecycleEvents: stampedEvidenceLifecycleEvents(),
    summary: { complete: true, total: 4, passed: 4, failed: [], knownTests: evidenceKnownTests },
  }
}

describe('run detail tabs', () => {
  it('orders an ordinary run Overview → Run Logs → Services → Heal Agent → Results & Fixes, opening on Overview', async () => {
    await show(detailOf())
    expect(tabs()).toEqual(['Overview', 'Run Logs', 'Services', 'Heal Agent', 'Results & Fixes'])
    expect(container.querySelector('[data-testid="results-tests"]')).toBeNull()
  })

  it('gives a verify run only its overview and results, and a boot session no results', async () => {
    await show(detailOf('verify'))
    expect(tabs()).toEqual(['Overview', 'Results & Fixes'])
    click('Results & Fixes')
    expect(container.querySelector('[data-testid="results-tests"]')).toBeTruthy()
    expect([...container.querySelectorAll('button')].some((b) => b.textContent === 'Run-wide')).toBe(false)
    await show(detailOf('boot', 'boot-1'))
    expect(tabs()).toEqual(['Overview', 'Run Logs', 'Services'])
  })

  it('lands a focused test on its expanded row in Results & Fixes', async () => {
    await show(detailOf(), { focusTest: 'test-case-applies-the-discount' })
    const open = container.querySelector('[data-open]')
    expect(open?.textContent).toContain('applies the discount')
    expect(open?.querySelector('select')?.value).toBe('2')
  })

  it('re-opens a collapsed row when the same test is clicked again, and only then', async () => {
    const detail = detailOf()
    const focus = { focusTest: 'test-case-applies-the-discount', focusTestId: 'discount' }
    await show(detail, { ...focus, focusRequest: 1 })
    const header = () => container.querySelector<HTMLButtonElement>('[data-open] > button')
    act(() => header()!.click())
    expect(container.querySelector('[data-open]')).toBeNull()
    // A pushed update with the same request leaves the reader's collapse alone.
    await show({ ...detail }, { ...focus, focusRequest: 1 })
    expect(container.querySelector('[data-open]')).toBeNull()
    click('Overview')
    await show(detail, { ...focus, focusRequest: 2 })
    expect(container.querySelector('[data-open]')?.textContent).toContain('applies the discount')
  })

  it('lands a captured-fixes arrival on the run-wide evidence', async () => {
    await show(detailOf(), { arriveTab: 'changes' })
    expect(container.querySelector('[data-testid="results-run-wide"]')).toBeTruthy()
  })

  it('keeps the reader’s case and cycle across a tab switch, and drops them for another run', async () => {
    await show(detailOf(), { focusTest: 'test-case-applies-the-discount' })
    const select = container.querySelector<HTMLSelectElement>('[data-open] select')!
    act(() => {
      select.value = '1'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    click('Overview')
    click('Results & Fixes')
    expect(container.querySelector<HTMLSelectElement>('[data-open] select')?.value).toBe('1')
    await show(detailOf('run', 'run-2'))
    click('Results & Fixes')
    expect(container.querySelector('[data-open]')).toBeNull()
  })

  it('keeps the live Heal Agent terminal mounted across a trip through Results & Fixes', async () => {
    const detail = detailOf()
    await show({ ...detail, manifest: { ...detail.manifest, status: 'healing', endedAt: undefined } })
    click('Heal Agent')
    click('Results & Fixes')
    click('Heal Agent')
    click('Overview')
    expect(paneTerminals.mounts.filter((id) => id === 'agent')).toHaveLength(1)
    // Hidden, not unmounted, while another tab shows.
    expect(container.querySelector('[hidden]')?.textContent).toContain('terminal')
  })

  it('keeps the Playwright terminal one click inside Results & Fixes', async () => {
    await show(detailOf())
    click('Results & Fixes')
    click('Terminal')
    expect(paneTerminals.props.map((p) => p.paneId)).toContain('playwright')
  })
})

describe('a full service log link', () => {
  const withServices = (): RunDetail => {
    const detail = detailOf()
    const service = (name: string, safeName: string) => ({ name, safeName, command: 'npm start', cwd: '/repo', logPath: `/logs/svc-${safeName}.log` })
    return { ...detail, manifest: { ...detail.manifest, services: [service('API', 'api'), service('Web', 'web')] } }
  }
  const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)) })
  const inspector = () => container.querySelector('[data-testid="service-log-inspector"]')

  it('opens the span on its own service, and Back returns to the same test and cycle', async () => {
    Element.prototype.scrollIntoView = () => {}
    await show(withServices(), { focusTest: 'test-case-applies-the-discount' })
    await settle()
    const open = container.querySelector<HTMLButtonElement>('[data-testid="open-full-service-log"]')!
    act(() => open.click())
    await settle()
    expect(container.querySelector('[data-testid="results-tests"]')).toBeNull()
    expect(inspector()?.querySelector('[data-testid="service-log-anchor"]')?.textContent)
      .toBe('Web · Repair cycle 2 · Before this repair · execution 2 · lines 120–124 highlighted')
    const { getRunServiceLogLines } = await import('@/shared/api/runs')
    expect(getRunServiceLogLines).toHaveBeenCalledWith('run-1', 'web', { execution: 2, from: 100, count: 600 })
    click('Back to Results & Fixes')
    const row = container.querySelector('[data-open]')
    expect(row?.textContent).toContain('applies the discount')
    expect(row?.querySelector('select')?.value).toBe('2')
  })

  it('returns to the live terminal on Latest output or another service, and forgets the link for another run', async () => {
    Element.prototype.scrollIntoView = () => {}
    const openLink = async () => {
      act(() => container.querySelector<HTMLButtonElement>('[data-testid="open-full-service-log"]')!.click())
      await settle()
    }
    await show(withServices(), { focusTest: 'test-case-applies-the-discount' })
    await settle()
    await openLink()
    paneTerminals.props = []
    click('Latest output')
    expect(inspector()).toBeNull()
    expect(paneTerminals.props.at(-1)?.paneId).toBe('service:web')

    click('Results & Fixes')
    await settle()
    await openLink()
    expect(inspector()).toBeTruthy()
    const apiTab = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('API'))!
    act(() => apiTab.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(inspector()).toBeNull()
    expect(paneTerminals.props.at(-1)?.paneId).toBe('service:api')
    // Back on Web, the link was consumed: the live terminal, not the span.
    const webTab = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('Web') && !b.textContent.includes('Results'))!
    act(() => webTab.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(inspector()).toBeNull()

    click('Results & Fixes')
    await settle()
    await openLink()
    expect(inspector()).toBeTruthy()
    await show({ ...withServices(), runId: 'run-2', manifest: { ...withServices().manifest, runId: 'run-2' } })
    click('Services')
    expect(inspector()).toBeNull()
  })
})

describe('a routed place inside the run', () => {
  const withServices = (runId = 'run-1'): RunDetail => {
    const detail = detailOf('run', runId)
    const service = (name: string, safeName: string) => ({ name, safeName, command: 'npm start', cwd: '/repo', logPath: `/logs/svc-${safeName}.log` })
    return { ...detail, manifest: { ...detail.manifest, services: [service('API', 'api'), service('Web', 'web')] } }
  }
  const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)) })
  const journal = [
    { iteration: 1, timestamp: '2026-10-08T10:04:30.000Z', feature: 'storefront', run: 'r', outcome: 'partial', hypothesis: null, cycle: 1, inputExecution: 1, failingTests: ['test-case-applies-the-discount'], body: '\n- hypothesis: rounding\n' },
  ]
  const discount = { test: { name: 'test-case-applies-the-discount', location: 'e2e/checkout.spec.ts:12' } }

  it('cold-loads a test, an earlier cycle and its journal entry, and reports the same place back', async () => {
    const { listJournal } = await import('@/shared/api/runs')
    vi.mocked(listJournal).mockResolvedValue(journal)
    const reports: unknown[] = []
    const location = { tab: 'results' as const, ...discount, cycle: 1, journal: 'entry' as const }
    await show(detailOf(), { focusTest: discount.test.name, focusTestLocation: discount.test.location, location, onLocationChange: (l) => reports.push(l) })
    await settle()
    const open = container.querySelector('[data-open]')
    expect(open?.textContent).toContain('applies the discount')
    expect(open?.querySelector('select')?.value).toBe('1')
    expect(document.querySelector('[data-testid="journal-source-modal"]')?.textContent).toBe('Iteration 1')
    expect(reports.at(-1)).toEqual(location)
  })

  it('keeps a restored Services place when the test it carries resolves', async () => {
    Element.prototype.scrollIntoView = () => {}
    const reports: unknown[] = []
    const log = { execution: 2, startLine: 120, endLine: 124, approximate: false }
    const location = { tab: 'services' as const, ...discount, service: 'web', log }
    await show(withServices(), { focusTest: discount.test.name, focusTestLocation: discount.test.location, location, onLocationChange: (l) => reports.push(l) })
    await settle()
    expect(container.querySelector('[data-testid="service-log-inspector"]')).toBeTruthy()
    expect(reports.at(-1)).toEqual(location)
    click('Back to Results & Fixes')
    expect(container.querySelector('[data-open]')?.textContent).toContain('applies the discount')
  })

  it('cold-loads a Full service log range on its service, even one the Services tab does not open first', async () => {
    Element.prototype.scrollIntoView = () => {}
    const log = { execution: 2, startLine: 120, endLine: 124, approximate: true }
    const reports: unknown[] = []
    await show(withServices(), { location: { tab: 'services', service: 'web', log }, onLocationChange: (l) => reports.push(l) })
    await settle()
    expect(container.querySelector('[data-testid="service-log-anchor"]')?.textContent)
      .toBe('Web · execution 2 · lines 120–124 highlighted · chosen by position among spans that share this test’s name')
    expect(reports.at(-1)).toEqual({ tab: 'services', service: 'web', log })
    click('Latest output')
    expect(reports.at(-1)).toEqual({ tab: 'services', service: 'web' })
  })

  it('reports each move: tab, test, cycle, sub-view and journal dialog', async () => {
    const { listJournal } = await import('@/shared/api/runs')
    vi.mocked(listJournal).mockResolvedValue(journal)
    const reports: unknown[] = []
    await show(detailOf(), { onLocationChange: (l) => reports.push(l) })
    expect(reports.at(-1)).toEqual({})
    click('Results & Fixes')
    expect(reports.at(-1)).toEqual({ tab: 'results' })
    const header = [...container.querySelectorAll<HTMLButtonElement>('[data-testid="case-result"] > button')].find((b) => b.textContent?.includes('applies the discount'))!
    act(() => header.click())
    expect(reports.at(-1)).toEqual({ tab: 'results', ...discount })
    const select = container.querySelector<HTMLSelectElement>('[data-open] select')!
    act(() => { select.value = '1'; select.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(reports.at(-1)).toEqual({ tab: 'results', ...discount, cycle: 1 })
    await settle()
    click('Full run journal')
    expect(reports.at(-1)).toEqual({ tab: 'results', ...discount, cycle: 1, journal: 'all' })
    click('Run-wide')
    expect(reports.at(-1)).toEqual({ tab: 'results', view: 'run-wide', ...discount, cycle: 1, journal: 'all' })
  })

  it('keeps naming a linked test until its events arrive, then explains a link this run never recorded', async () => {
    const reports: unknown[] = []
    const early = { ...detailOf(), playbackEvents: [], summary: { complete: false, total: 4, passed: 0, failed: [], knownTests: [] } }
    await show(early, { focusTest: 'test-case-gone', onLocationChange: (l) => reports.push(l) })
    expect(reports.at(-1)).toEqual({ tab: 'results', test: { name: 'test-case-gone' } })
    expect(container.querySelector('[data-testid="stale-test-link"]')).toBeNull()
    await show(detailOf(), { focusTest: 'test-case-gone', onLocationChange: (l) => reports.push(l) })
    expect(container.querySelector('[data-testid="stale-test-link"]')?.textContent).toContain('(test-case-gone)')
    expect(container.querySelector('[data-open]')).toBeNull()
  })

  it('explains a stale cycle and a stale service instead of swapping them silently', async () => {
    await show(detailOf(), { focusTest: discount.test.name, focusTestLocation: discount.test.location, location: { tab: 'results', ...discount, cycle: 7 } })
    expect(container.querySelector('[data-testid="stale-cycle-link"]')?.textContent).toBe('Repair cycle 7 did not address this test; showing repair cycle 2.')
    expect(container.querySelector<HTMLSelectElement>('[data-open] select')?.value).toBe('2')
    // A cold load mounts the detail afresh.
    act(() => root.unmount())
    root = createRoot(container)
    await show(withServices('run-9'), { location: { tab: 'services', service: 'worker' } })
    expect(container.querySelector('[data-testid="stale-service-link"]')?.textContent).toBe('This link names a service this run did not start (worker); showing API.')
    expect(paneTerminals.props.at(-1)?.paneId).toBe('service:api')
  })
})
