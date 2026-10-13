import { act } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ServiceLogLines } from '@shared/run-detail'
import { mountRoot, type MountedRoot } from '@/test-helpers/mount-root'
import type { ServiceLogAnchor } from '../utils/results-fixes'
import { ANCHOR_CONTEXT_LINES, ANCHOR_WINDOW_LINES, ServiceLogInspector } from './ServiceLogInspector'

vi.mock(import('@/shared/api/runs'), async (importOriginal) => ({ ...(await importOriginal()), getRunServiceLogLines: vi.fn() }))

let m: MountedRoot
mountRoot({ attach: true, onMount: (mounted) => { m = mounted } })
let runSeq = 0
const scrolled: Array<{ line: string | null; block: ScrollLogicalPosition | undefined }> = []

const anchor = (over: Partial<ServiceLogAnchor> = {}): ServiceLogAnchor => ({
  service: 'api', execution: 2, startLine: 50, endLine: 52, approximate: false,
  caseTitle: 'reserves stock', context: 'Repair cycle 1 · Before this repair', ...over,
})
/** Serves numbered lines `line N` from a log of `total` lines. */
function serveLog(total: number) {
  return async (_runId: string, service: string, { execution, from, count }: { execution: number; from: number; count: number }): Promise<ServiceLogLines> => {
    const last = Math.min(total, from + count - 1)
    return {
      service, execution, source: 'segment', totalLines: total, firstLine: from,
      lines: Array.from({ length: Math.max(0, last - from + 1) }, (_, i) => `line ${from + i}`), truncated: last < total,
    }
  }
}

async function render(a: ServiceLogAnchor, handlers: { onBack?: () => void; onLatest?: () => void } = {}) {
  await act(async () => {
    m.root.render(<ServiceLogInspector runId={`inspect-run-${++runSeq}`} anchor={a} serviceName="API" onBack={handlers.onBack ?? vi.fn()} onLatest={handlers.onLatest ?? vi.fn()} />)
    await new Promise((r) => setTimeout(r, 0))
  })
}
const rows = () => [...m.container.querySelectorAll<HTMLElement>('[data-line]')]
const button = (label: string) => [...m.container.querySelectorAll('button')].find((b) => b.textContent?.startsWith(label)) as HTMLButtonElement | undefined
async function click(b: HTMLButtonElement | undefined) {
  await act(async () => {
    b!.click()
    await new Promise((r) => setTimeout(r, 0))
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  scrolled.length = 0
  Element.prototype.scrollIntoView = function (this: Element, opts?: boolean | ScrollIntoViewOptions) {
    scrolled.push({ line: this.getAttribute('data-line'), block: typeof opts === 'object' ? opts.block : undefined })
  }
})

describe('the anchored log', () => {
  it('opens a little above the span, highlights it by line number and lands on it once', async () => {
    const runsApi = await import('@/shared/api/runs')
    vi.mocked(runsApi.getRunServiceLogLines).mockImplementation(serveLog(2000))
    await render(anchor())
    expect(runsApi.getRunServiceLogLines).toHaveBeenCalledWith(expect.any(String), 'api', { execution: 2, from: 50 - ANCHOR_CONTEXT_LINES, count: ANCHOR_WINDOW_LINES })
    expect(rows()[0].dataset.line).toBe('30')
    expect(rows().filter((r) => r.hasAttribute('data-highlighted')).map((r) => r.dataset.line)).toEqual(['50', '51', '52'])
    expect(scrolled).toEqual([{ line: '50', block: 'center' }])
    expect(m.container.querySelector('[data-testid="service-log-anchor"]')?.textContent)
      .toBe('API · Repair cycle 1 · Before this repair · execution 2 · lines 50–52 highlighted')
    expect(m.container.textContent).toContain('reserves stock')
  })

  it('pages earlier and later without landing again', async () => {
    const runsApi = await import('@/shared/api/runs')
    vi.mocked(runsApi.getRunServiceLogLines).mockImplementation(serveLog(2000))
    await render(anchor({ startLine: 900, endLine: 940 }))
    expect(scrolled).toEqual([{ line: '900', block: 'start' }])
    expect(button('Later lines')?.textContent).toBe('Later lines (521 more)')
    await click(button('Later lines'))
    expect(rows()[0].dataset.line).toBe(String(880 + ANCHOR_WINDOW_LINES))
    await click(button('Earlier lines'))
    expect(rows()[0].dataset.line).toBe('880')
    await click(button('Earlier lines'))
    expect(rows()[0].dataset.line).toBe('280')
    expect(scrolled).toHaveLength(1)
  })

  it('starts at line 1 for a span near the top, and offers no paging past either end', async () => {
    const runsApi = await import('@/shared/api/runs')
    vi.mocked(runsApi.getRunServiceLogLines).mockImplementation(serveLog(12))
    await render(anchor({ startLine: 3, endLine: 4 }))
    expect(rows().map((r) => r.dataset.line)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'])
    expect(button('Earlier lines')).toBeUndefined()
    expect(button('Later lines')).toBeUndefined()
  })

  it('says when the retained log cannot be read', async () => {
    const runsApi = await import('@/shared/api/runs')
    vi.mocked(runsApi.getRunServiceLogLines).mockRejectedValue(new Error('not retained'))
    await render(anchor({ approximate: true }))
    expect(m.container.querySelector('[data-testid="service-log-unavailable"]')?.textContent).toContain("Execution 2's log for API could not be read (not retained)")
    expect(m.container.querySelector('[data-testid="service-log-anchor"]')?.textContent).toContain('chosen by position')
  })

  it('shows a reading state, then returns to Results & Fixes or the live output', async () => {
    const runsApi = await import('@/shared/api/runs')
    vi.mocked(runsApi.getRunServiceLogLines).mockReturnValue(new Promise(() => {}))
    const onBack = vi.fn()
    const onLatest = vi.fn()
    await render(anchor(), { onBack, onLatest })
    expect(m.container.textContent).toContain('Reading the retained log…')
    await click(button('Back to Results'))
    await click(button('Latest output'))
    expect(onBack).toHaveBeenCalledOnce()
    expect(onLatest).toHaveBeenCalledOnce()
  })
})
