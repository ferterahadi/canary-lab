import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { useServiceExcerpts, useServiceLogLines } from './use-service-logs'

vi.mock(import('@/shared/api/runs'), async (importOriginal) => ({
  ...(await importOriginal()),
  getRunServiceExcerpts: vi.fn(),
  getRunServiceLogLines: vi.fn(),
}))

let excerpts: ReturnType<typeof useServiceExcerpts> | undefined
let lines: ReturnType<typeof useServiceLogLines> | undefined
function Excerpts({ runId, query, latest }: { runId: string; query: Parameters<typeof useServiceExcerpts>[1]; latest: number }) {
  excerpts = useServiceExcerpts(runId, query, latest)
  return null
}
function Lines({ runId }: { runId: string }) {
  lines = useServiceLogLines(runId, 'api', 2, 41, 600)
  return null
}

async function mount(node: React.ReactNode) {
  const root = createRoot(document.createElement('div'))
  await act(async () => {
    root.render(node)
    await new Promise((r) => setTimeout(r, 0))
  })
  return root
}

afterEach(() => vi.clearAllMocks())

it('reads one attempt’s spans, and again when a new execution moves the live log', async () => {
  const runsApi = await import('@/shared/api/runs')
  vi.mocked(runsApi.getRunServiceExcerpts).mockResolvedValue({ execution: 2, excerpts: [] })
  const query = { execution: 2, name: 'test-case-x', occurrence: 1 }
  const root = await mount(<Excerpts runId="svc-run-1" query={query} latest={2} />)
  expect(runsApi.getRunServiceExcerpts).toHaveBeenCalledWith('svc-run-1', query)
  expect(excerpts?.value).toEqual({ execution: 2, excerpts: [] })
  await act(async () => {
    root.render(<Excerpts runId="svc-run-1" query={query} latest={3} />)
    await new Promise((r) => setTimeout(r, 0))
  })
  expect(runsApi.getRunServiceExcerpts).toHaveBeenCalledTimes(2)
  act(() => root.unmount())
})

it('reads nothing without a finished attempt', async () => {
  const runsApi = await import('@/shared/api/runs')
  const root = await mount(<Excerpts runId="svc-run-2" query={null} latest={1} />)
  expect(runsApi.getRunServiceExcerpts).not.toHaveBeenCalled()
  expect(excerpts?.value).toBeNull()
  act(() => root.unmount())
})

it('reads a window of one service’s retained log', async () => {
  const runsApi = await import('@/shared/api/runs')
  const window = { service: 'api', execution: 2, source: 'segment' as const, totalLines: 900, firstLine: 41, lines: ['a'], truncated: true }
  vi.mocked(runsApi.getRunServiceLogLines).mockResolvedValue(window)
  const root = await mount(<Lines runId="svc-run-3" />)
  expect(runsApi.getRunServiceLogLines).toHaveBeenCalledWith('svc-run-3', 'api', { execution: 2, from: 41, count: 600 })
  expect(lines?.value).toEqual(window)
  act(() => root.unmount())
})
