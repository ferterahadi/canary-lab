import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { main } from './boot'
import { fail, info, ok } from '../../shared/cli-ui/ui'

vi.mock('../../shared/cli-ui/ui', () => ({
  banner: vi.fn(), section: vi.fn(), ok: vi.fn(), fail: vi.fn(), info: vi.fn(), dim: (text: string) => text, line: vi.fn(),
}))
vi.mock('../../shared/runtime/project-root', () => ({ getProjectRoot: () => '/workspace' }))
vi.mock('../web-server/src/features/runs/logic/runtime/launcher/project-config', () => ({
  DEFAULT_PORT: 7421, loadProjectConfig: () => ({}), resolveProjectPort: () => 7421,
}))
const fetchImpl = vi.fn<typeof fetch>()
beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('fetch', fetchImpl)
  vi.spyOn(process, 'exit').mockImplementation((code) => { throw new Error(`exit ${code}`) })
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

it.each([200, 201])('reports a started boot for HTTP %s', async (status) => {
  fetchImpl.mockResolvedValueOnce(new Response('{"runId":"run-1"}', { status }))
  await main(['shop', 'local'])
  expect(ok).toHaveBeenCalledWith(expect.stringContaining('Booting "shop" (local)'))
  expect(fetchImpl).toHaveBeenCalledWith('http://localhost:7421/api/runs', expect.objectContaining({ body: '{"feature":"shop","env":"local","mode":"boot"}' }))
})

it('reports a queued boot for HTTP 202', async () => {
  fetchImpl.mockResolvedValueOnce(new Response('{"runId":"run-1","queueReason":"resources"}', { status: 202 }))
  await main(['shop'])
  expect(ok).toHaveBeenCalledWith('Boot queued (runId run-1, reason: resources).')
})

it('keeps the collision-specific recovery message for HTTP 409', async () => {
  fetchImpl.mockResolvedValueOnce(new Response('{"type":"repo_collision_requires_choice","conflictingFeature":"other"}', { status: 409 }))
  await expect(main(['shop'])).rejects.toThrow('exit 1')
  expect(fail).toHaveBeenCalledWith('Another run (other) is using the same app.')
  expect(info).toHaveBeenCalledWith(expect.stringContaining('worktree/queue choice'))
})

it('keeps the server-start guidance on transport failure', async () => {
  fetchImpl.mockRejectedValueOnce(new Error('offline'))
  await expect(main(['shop'])).rejects.toThrow('exit 1')
  expect(fail).toHaveBeenCalledWith(expect.stringContaining('Could not reach the Canary Lab server'))
})

it('stops a run through the encoded abort URL', async () => {
  fetchImpl.mockResolvedValueOnce(new Response('{}'))
  await main(['stop', 'run/1'])
  expect(fetchImpl).toHaveBeenCalledWith('http://localhost:7421/api/runs/run%2F1/abort', expect.objectContaining({ body: '{}' }))
  expect(ok).toHaveBeenCalledWith(expect.stringContaining('Stopped run/1'))
})
