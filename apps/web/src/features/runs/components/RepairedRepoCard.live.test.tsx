import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { repositoryConsumerKey } from '@shared/repository-observation'
import { InvalidationProvider, useInvalidation } from '@/shared/state/invalidation'
import { RepairedRepoCard, useRepoOpener } from './RepairedRepoCard'

let root: Root
let host: HTMLDivElement
let invalidate: ReturnType<typeof useInvalidation>['invalidate']
let reader: ReturnType<typeof useRepoOpener>
let files: string[]
const reply = () => new Response(JSON.stringify({ targets: [{ repoName: 'app', repoRoot: '/repo', ready: true, branch: 'main', foreignDirty: files }] }))
const fetcher = vi.fn<typeof fetch>()
const repo = { repoName: 'app', repoRoot: '/repo', patchFile: 'app.patch', patchPath: '/patch', files: 1, fileNames: ['app.ts'], baseSha: 'base' }
function Reader({ runId, enabled = true, provisional = false }: { runId: string; enabled?: boolean; provisional?: boolean }) {
  reader = useRepoOpener(runId, enabled, provisional)
  invalidate = useInvalidation().invalidate
  return <>{reader.confirm}<RepairedRepoCard {...reader.cardProps('app')} repoName="app" repo={repo} auto={false} provisional={provisional} onProposeClick={() => {}} /></>
}
const render = (runId = 'one', enabled = true, provisional = false) => act(async () => { root.render(<InvalidationProvider><Reader runId={runId} enabled={enabled} provisional={provisional} /></InvalidationProvider>) })
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })
const open = () => host.querySelector<HTMLButtonElement>('[data-testid="changes-open-repo-app"]')!
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(0); files = ['foreign.ts']
  fetcher.mockReset().mockImplementation(async () => reply()); vi.stubGlobal('fetch', fetcher)
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers(); vi.unstubAllGlobals() })

it('updates a mounted card and open confirmation through scoped events, reconnect and missed-event recovery', async () => {
  await render(); expect(fetcher).toHaveBeenCalledTimes(1)
  await render(); expect(fetcher).toHaveBeenCalledTimes(1)
  await act(async () => { open().click() }); expect(document.body.textContent).toContain('1 file in this repo')
  files = ['one.ts', 'two.ts']
  await act(async () => { invalidate('repos', repositoryConsumerKey({ runId: 'other' })) })
  expect(fetcher).toHaveBeenCalledTimes(1)
  await act(async () => { invalidate('repos', repositoryConsumerKey({ runId: 'one' })) })
  expect(document.body.textContent).toContain('2 files in this repo')
  files = []
  await advance(30000); expect(document.body.textContent).toContain('The unrelated changes are gone.')
  files = ['back.ts']
  await act(async () => { invalidate('repos') })
  expect(document.body.textContent).toContain('1 file in this repo')
})

it('retains unavailable evidence, gates apply, retries and expires a hung read without erasing action errors', async () => {
  await render()
  fetcher.mockRejectedValueOnce(new Error('unreadable index'))
  await advance(30000)
  expect(open().disabled).toBe(true); expect(host.textContent).toContain('unreadable index'); expect(host.textContent).toContain('Last known status shown')
  await advance(30000); expect(open().disabled).toBe(false)
  fetcher.mockImplementation(() => new Promise(() => {}))
  await advance(45000); expect(open().disabled).toBe(true)
  files = []; fetcher.mockImplementation(async () => reply())
  await act(async () => { window.dispatchEvent(new Event('online')) }); expect(open().disabled).toBe(false)
  fetcher.mockImplementation(async (_url, init) => init?.method === 'POST' ? new Response(JSON.stringify({ error: 'apply refused' }), { status: 409 }) : reply())
  await act(async () => { open().click() }); expect(host.textContent).toContain('apply refused')
  await advance(30000); expect(host.textContent).toContain('apply refused')
})

it('does no preflight for provisional work, ignores late actions after selection change, and releases recovery on unmount', async () => {
  await render('one', false); expect(fetcher).not.toHaveBeenCalled()
  await render('one', true, true); expect(fetcher).not.toHaveBeenCalled()
  let finish!: (r: Response) => void
  fetcher.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
  await act(async () => { open().click() })
  await render('two', true, true)
  await act(async () => { finish(new Response(JSON.stringify({ opened: false, error: 'old error' }))) })
  expect(host.textContent).not.toContain('old error')
  await render('two')
  await act(async () => { root.render(null) })
  const reads = fetcher.mock.calls.length
  await advance(90000); window.dispatchEvent(new Event('focus'))
  expect(fetcher).toHaveBeenCalledTimes(reads); expect(vi.getTimerCount()).toBe(0)
})

it('does not open an editor for a different selection when an apply completes late', async () => {
  files = []; await render()
  let finish!: (r: Response) => void
  fetcher.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
  await act(async () => { open().click() })
  await render('two')
  const reads = fetcher.mock.calls.length
  await act(async () => { finish(new Response(JSON.stringify({ results: [{ ok: true }], allOk: true }))) })
  expect(fetcher).toHaveBeenCalledTimes(reads)
  expect(host.textContent).not.toContain('Opening…')
})
