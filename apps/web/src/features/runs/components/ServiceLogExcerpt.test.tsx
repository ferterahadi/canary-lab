import { act } from 'react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { buildRunEvidence, type EvidenceAttempt } from '@shared/run-evidence'
import type { ServiceLogExcerpt, ServiceLogExcerpts } from '@shared/run-detail'
import { evidenceKnownTests, stampedEvidenceLifecycleEvents, stampedEvidencePlaybackEvents } from '@shared/__fixtures__/run-evidence'
import { mountRoot, type MountedRoot } from '@/test-helpers/mount-root'
import type { ServiceLogAnchor } from '../utils/results-fixes'
import { ServiceLogsSection } from './ServiceLogExcerpt'

vi.mock(import('@/shared/api/runs'), async (importOriginal) => ({ ...(await importOriginal()), getRunServiceExcerpts: vi.fn() }))

let m: MountedRoot
mountRoot({ attach: true, onMount: (mounted) => { m = mounted } })
let runSeq = 0

const evidence = buildRunEvidence({ events: stampedEvidencePlaybackEvents(), known: evidenceKnownTests, lifecycle: stampedEvidenceLifecycleEvents() })
const inventory = evidence.cases.find((c) => c.location === 'e2e/inventory.spec.ts:8')!
const retry = inventory.attempts[1]

const captured = (over: Partial<ServiceLogExcerpt> = {}): ServiceLogExcerpt => ({
  service: 'api', name: 'API', execution: 1, source: 'segment', totalLines: 900, matchedBy: 'marker',
  span: { startLine: 40, endLine: 43, closed: true }, window: { firstLine: 41, lines: ['GET /stock 200', 'reserve failed: 409'], truncated: false },
  ...over,
})

async function render(attempt: EvidenceAttempt, response: ServiceLogExcerpts | Error, opts: { onOpenFullLog?: (a: ServiceLogAnchor) => void; cycle?: string } = {}) {
  const runsApi = await import('@/shared/api/runs')
  if (response instanceof Error) vi.mocked(runsApi.getRunServiceExcerpts).mockRejectedValue(response)
  else vi.mocked(runsApi.getRunServiceExcerpts).mockResolvedValue(response)
  await act(async () => {
    m.root.render(
      <ServiceLogsSection
        runId={`excerpt-run-${++runSeq}`}
        evidence={evidence}
        attempt={attempt}
        label="Before this repair"
        caseTitle={inventory.title}
        {...opts}
      />,
    )
    await new Promise((r) => setTimeout(r, 0))
  })
}
const q = (id: string) => m.container.querySelector(`[data-testid="${id}"]`)

beforeEach(() => vi.clearAllMocks())

describe('a finished attempt’s service output', () => {
  it('reads the attempt’s own span — a retry by its position — and shows it with its provenance', async () => {
    const runsApi = await import('@/shared/api/runs')
    await render(retry, { execution: 1, excerpts: [captured()] })
    expect(runsApi.getRunServiceExcerpts).toHaveBeenCalledWith(expect.stringMatching(/^excerpt-run-/), { execution: 1, name: 'test-case-reserves-stock', occurrence: 1, of: 2 })
    expect(q('service-excerpt-caption')?.textContent).toBe('Before this repair · execution 1 · lines 40–43 of 900')
    const pre = q('service-excerpt')!
    expect(pre.className).toContain('max-h-40')
    expect([...pre.querySelectorAll(':scope > span')].map((row) => row.textContent)).toEqual(['41GET /stock 200', '42reserve failed: 409'])
    // One service needs no selector.
    expect(m.container.querySelector('select')).toBeNull()
    expect(m.container.textContent).toContain('API')
    expect(m.container.textContent).toContain('1 service')
  })

  it('switches between services that printed during the test, skipping those that did not', async () => {
    await render(retry, { execution: 1, excerpts: [
      captured(),
      { service: 'worker', name: 'Worker', execution: 1, missing: 'no-marker' },
      captured({ service: 'web', name: 'Web', window: { firstLine: 7, lines: ['render /cart'], truncated: false } }),
    ] })
    const select = m.container.querySelector('select')!
    expect([...select.options].map((o) => o.textContent)).toEqual(['API', 'Web'])
    await act(async () => {
      select.value = 'web'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(q('service-excerpt')?.textContent).toBe('7render /cart')
    expect(m.container.textContent).toContain('2 services')
  })

  it('names a positional match, a span the end marker never closed, and a silent service', async () => {
    await render(retry, { execution: 1, excerpts: [captured({ matchedBy: 'order', span: { startLine: 40, endLine: 40, closed: false }, window: { firstLine: 41, lines: [], truncated: false } })] })
    expect(q('service-excerpt')?.textContent).toBe('The service printed nothing during this test.')
    expect(m.container.textContent).toContain('chosen by position among spans that share this test’s name')
    expect(m.container.textContent).toContain('the end marker never arrived')
  })

  it('opens the full log at the span, carrying where it was opened from', async () => {
    const onOpenFullLog = vi.fn()
    await render(retry, { execution: 1, excerpts: [captured({ matchedBy: 'order' })] }, { onOpenFullLog, cycle: 'Repair cycle 1' })
    const button = q('open-full-service-log') as HTMLButtonElement
    act(() => button.click())
    expect(onOpenFullLog).toHaveBeenCalledWith({
      service: 'api', execution: 1, startLine: 40, endLine: 43, approximate: true,
      caseTitle: inventory.title, context: 'Repair cycle 1 · Before this repair',
    })
    // Without a cycle the label alone says what it was.
    onOpenFullLog.mockClear()
    await render(retry, { execution: 1, excerpts: [captured()] }, { onOpenFullLog })
    act(() => (q('open-full-service-log') as HTMLButtonElement).click())
    expect(onOpenFullLog).toHaveBeenCalledWith(expect.objectContaining({ approximate: false, context: 'Before this repair' }))
  })

  it('offers no full log without a target or a captured span', async () => {
    await render(retry, { execution: 1, excerpts: [captured()] })
    expect(q('open-full-service-log')).toBeNull()
    await render(retry, { execution: 1, excerpts: [] }, { onOpenFullLog: vi.fn() })
    expect(q('open-full-service-log')).toBeNull()
  })
})

describe('when there is nothing to show', () => {
  it('says the output was not retained, or that no service marked this test', async () => {
    await render(retry, { execution: 1, excerpts: [{ service: 'api', name: 'API', execution: 1, missing: 'not-retained' }] })
    expect(m.container.textContent).toContain("Execution 1's service output was not retained")
    await render(retry, { execution: 1, excerpts: [{ service: 'api', name: 'API', execution: 1, missing: 'no-marker' }] })
    expect(m.container.textContent).toContain("No service printed this test's markers in execution 1.")
  })

  it('reports a failed read', async () => {
    await render(retry, new Error('boom'))
    expect(m.container.textContent).toContain('Failed to read the service logs: boom')
  })

  it('does not read while the attempt is running, or for an attempt with no execution', async () => {
    const runsApi = await import('@/shared/api/runs')
    await render({ ...retry, endedAt: undefined }, { execution: 1, excerpts: [] })
    expect(m.container.textContent).toContain('Service output for this attempt is still being written.')
    await render({ ...retry, executionIndex: undefined }, { execution: 1, excerpts: [] })
    expect(m.container.textContent).toContain('not tied to a recorded execution')
    expect(runsApi.getRunServiceExcerpts).not.toHaveBeenCalled()
  })

  it('shows a reading state until the spans arrive', async () => {
    const runsApi = await import('@/shared/api/runs')
    vi.mocked(runsApi.getRunServiceExcerpts).mockReturnValue(new Promise(() => {}))
    await act(async () => {
      m.root.render(<ServiceLogsSection runId="excerpt-pending" evidence={evidence} attempt={retry} label="Test result" caseTitle="t" />)
    })
    expect(m.container.textContent).toContain('Reading service logs…')
  })
})
