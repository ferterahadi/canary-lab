import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi, type MockInstance } from 'vitest'
import { repositoryConsumerKey } from '@shared/repository-observation'
import { InvalidationProvider, useInvalidation } from '@/shared/state/invalidation'
import { StageErrorPanel } from '../components/StageStatePanels'
import { useFlightRemedy } from './use-flight-remedy'
import { advanceAct as advance } from '@/test-helpers/advance-act'
import { mountRoot } from '@/test-helpers/mount-root'

let root: Root
let container: HTMLDivElement
let live: ReturnType<typeof useFlightRemedy>
let invalidate: ReturnType<typeof useInvalidation>['invalidate']
let modified: number
let fetcher: MockInstance<typeof fetch>
const reply = (count: number) => new Response(JSON.stringify({ remedy: { kind: 'dirty-repos', repos: count ? [{ name: 'service', path: '/repo/service', modified: count }] : [] } }))
function Reader({ flightId }: { flightId: string }) {
  live = useFlightRemedy(flightId, 'has uncommitted changes')
  invalidate = useInvalidation().invalidate
  return <StageErrorPanel flightId={flightId} stageLabel="Parallel readiness" detail="has uncommitted changes" />
}
const render = (flightId = 'flight') => act(async () => { root.render(<InvalidationProvider><Reader flightId={flightId} /></InvalidationProvider>) })
const button = () => container.querySelector<HTMLButtonElement>('[data-testid="stage-remedy-stash"]')!
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(0); modified = 2
  fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => reply(modified))
})
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })
mountRoot({ attach: true, onMount: (mounted) => ({ container, root } = mounted) })

it('shares simultaneous reads and keeps an open panel current after scoped events and missed events, including zero-to-dirty', async () => {
  await render()
  expect(fetcher).toHaveBeenCalledTimes(1) // probe and panel share one HTTP inspection
  expect(container.textContent).toContain('2 modified')
  await render(); expect(fetcher).toHaveBeenCalledTimes(1)
  await act(async () => { invalidate('repos', repositoryConsumerKey({ flightId: 'unrelated' })) })
  expect(fetcher).toHaveBeenCalledTimes(1)
  modified = 0
  await act(async () => { invalidate('repos', repositoryConsumerKey({ flightId: 'flight' })) })
  expect(container.textContent).toContain('clean'); expect(button()).toBeNull()
  modified = 1 // intentionally no event
  await advance(29999); expect(container.textContent).toContain('clean')
  let finish!: (response: Response) => void
  fetcher.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
  await advance(1)
  await act(async () => { finish(reply(1)) })
  expect(container.textContent).toContain('1 modified'); expect(button().disabled).toBe(false)
  modified = 2
  await act(async () => { invalidate('repos') }) // workspace reconnect
  expect(container.textContent).toContain('2 modified')
  await act(async () => { invalidate('flights') })
  expect(fetcher).toHaveBeenCalledTimes(5)
})

it('retains failed-read evidence, disables remedies, retries, and expires evidence when a read hangs', async () => {
  await render()
  fetcher.mockRejectedValueOnce(new Error('offline'))
  await advance(30000)
  expect(container.textContent).toContain('2 modified'); expect(container.textContent).toContain('offline')
  expect(button().disabled).toBe(true)
  await advance(30000); expect(button().disabled).toBe(false)
  fetcher.mockImplementation(() => new Promise(() => {}))
  await advance(45000)
  expect(button().disabled).toBe(true); expect(container.textContent).toContain('stale')
  fetcher.mockImplementation(async () => reply(1))
  await act(async () => { window.dispatchEvent(new Event('online')) })
  expect(container.textContent).toContain('1 modified'); expect(button().disabled).toBe(false)
})

it('pauses hidden readers, rejects late responses, and refreshes immediately when visible', async () => {
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
  await render(); await advance(90000)
  expect(fetcher).not.toHaveBeenCalled(); expect(live.confirmed).toBe(false)
  visibility.mockReturnValue('visible')
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
  expect(fetcher).toHaveBeenCalledTimes(1)
  let finish!: (response: Response) => void
  fetcher.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
  await act(async () => { live.refresh() })
  visibility.mockReturnValue('hidden')
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
  await act(async () => { finish(reply(9)) })
  expect(live.remedy?.repos[0].modified).toBe(2); expect(live.confirmed).toBe(false)
  const count = fetcher.mock.calls.length
  await advance(90000); expect(fetcher).toHaveBeenCalledTimes(count)
  visibility.mockReturnValue('visible'); modified = 0
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
  expect(live.remedy?.repos).toEqual([])
  await act(async () => { root.render(null) })
  const settled = fetcher.mock.calls.length
  await advance(90000); window.dispatchEvent(new Event('focus'))
  expect(fetcher).toHaveBeenCalledTimes(settled); expect(vi.getTimerCount()).toBe(0)
})

it('revalidates after partial mutation failure and retains action errors across successful background reads', async () => {
  await render()
  fetcher.mockImplementation(async (_url, init) => init?.method === 'POST'
    ? new Response(JSON.stringify({ error: 'second repository failed' }), { status: 500 }) : reply(1))
  await act(async () => { button().click() })
  expect(container.textContent).toContain('second repository failed'); expect(container.textContent).toContain('1 modified')
  await advance(30000); expect(container.textContent).toContain('second repository failed')
  fetcher.mockImplementation(async (_url, init) => init?.method === 'POST' ? new Response('{}') : reply(0))
  await act(async () => { button().click() })
  expect(container.textContent).not.toContain('second repository failed'); expect(container.textContent).toContain('clean')
})

it('ignores mutation completion after changing Flight or unmounting and ignores old detail responses', async () => {
  await render()
  let finish!: (response: Response) => void
  fetcher.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
  await act(async () => { button().click() })
  await render('other')
  const count = fetcher.mock.calls.length
  await act(async () => { finish(new Response(JSON.stringify({ error: 'old failure' }), { status: 500 })) })
  expect(fetcher).toHaveBeenCalledTimes(count); expect(container.textContent).not.toContain('old failure')
  fetcher.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
  await act(async () => { live.refresh() })
  fetcher.mockImplementation(async () => new Response(JSON.stringify({ remedy: null })))
  await render('no-remedy')
  await act(async () => { finish(reply(8)) })
  expect(live.remedy).toBeNull(); expect(container.querySelector('[data-testid="stage-remedy"]')).toBeNull()
  await act(async () => { root.render(null) })
  expect(vi.getTimerCount()).toBe(0)
})
