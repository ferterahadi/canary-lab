// @vitest-environment happy-dom
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { beforeEach, expect, it, vi } from 'vitest'
import { useDiscoveryRepair } from './use-discovery-repair'
import type { DiscoveryRepairView } from '../api/discovery-repair'
import type { connectReconnectingSocket } from '../api/reconnecting-socket'
import { deferred } from '../../../../../tools/test-helpers/deferred'
import { mountRoot } from '@/test-helpers/mount-root'
const api = vi.hoisted(() => ({ listDiscoveryRepairs: vi.fn(), startDiscoveryRepair: vi.fn() }))
const socket = vi.hoisted(() => ({ connect: vi.fn() }))
vi.mock('../api/discovery-repair', () => api)
vi.mock('../api/reconnecting-socket', () => ({ defaultWsBase: () => 'ws://synthetic', connectReconnectingSocket: socket.connect }))
let root: Root
let current: ReturnType<typeof useDiscoveryRepair>
let connections: { options: Parameters<typeof connectReconnectingSocket>[0]; close: ReturnType<typeof vi.fn> }[]
function Host({ feature }: { feature: string | null }) { current = useDiscoveryRepair(feature); return null }

function repair(feature: string, updatedAt = '1', status: DiscoveryRepairView['status'] = 'repairing'): DiscoveryRepairView {
  return { id: feature, feature, updatedAt, status, featureDir: '/workspace/features/suite', owner: { kind: 'internal', agent: 'codex' }, createdAt: '1', heartbeatAt: '1', message: '', diagnostic: '', log: [], promptPath: '/workspace/prompt.md', promptReady: true }
}
beforeEach(() => {
  vi.resetAllMocks()
  api.listDiscoveryRepairs.mockResolvedValue([])
  connections = []
  socket.connect.mockImplementation((options) => { const close = vi.fn(); connections.push({ options, close }); return { close } })
})
mountRoot({ attach: true, onMount: (mounted) => ({ root } = mounted) })

it.each(['success', 'failure'])('an old feature %s releases only its own lock, leaving the new feature Starting', async (outcome) => {
  const a = deferred<DiscoveryRepairView>()
  const b = deferred<DiscoveryRepairView>()
  api.startDiscoveryRepair.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise)
  await act(async () => root.render(<Host feature="a" />))
  await act(async () => { void current.start(); void current.start() })
  await act(async () => root.render(<Host feature="b" />))
  await act(async () => { void current.start() })
  expect(api.startDiscoveryRepair.mock.calls).toEqual([['a'], ['b']])
  await act(async () => outcome === 'success' ? a.resolve(repair('a')) : a.reject(new Error('old error')))
  expect(current.starting).toBe(true)
  expect(current.startError).toBeNull()
  expect(current.repairs).toEqual([])
  await act(async () => b.resolve(repair('b')))
  expect(current.starting).toBe(false)
  expect(current.repairs.map((r) => r.id)).toEqual(['b'])
})

it.each(['success', 'failure'])('A → B → A suppresses duplicates and rejects the first A %s', async (outcome) => {
  const a = deferred<DiscoveryRepairView>()
  api.startDiscoveryRepair.mockReturnValueOnce(a.promise).mockResolvedValueOnce(repair('a', '3'))
  await act(async () => root.render(<Host feature="a" />))
  await act(async () => { void current.start() })
  await act(async () => root.render(<Host feature="b" />))
  await act(async () => root.render(<Host feature="a" />))
  expect(current.starting).toBe(true)
  await act(async () => { void current.start() })
  expect(api.startDiscoveryRepair).toHaveBeenCalledTimes(1)
  await act(async () => outcome === 'success' ? a.resolve(repair('a')) : a.reject(new Error('old error')))
  expect(current.repairs).toEqual([])
  expect(current.startError).toBeNull()
  expect(current.starting).toBe(false)
  await act(async () => { void current.start() })
  expect(current.repairs[0].updatedAt).toBe('3')
})

it('retains stream authority over initial REST and POST, accepts reconnect snapshots, and ignores malformed/closed frames', async () => {
  const initial = deferred<DiscoveryRepairView[]>()
  const start = deferred<DiscoveryRepairView>()
  api.listDiscoveryRepairs.mockReturnValueOnce(initial.promise)
  api.startDiscoveryRepair.mockReturnValueOnce(start.promise)
  await act(async () => root.render(<Host feature="a" />))
  const connection = connections[0]
  expect(connection.options).toMatchObject({ maxReconnects: Infinity, reconnectDelayMs: 1000 })
  await act(async () => { void current.start() })
  act(() => connection.options.onMessage(JSON.stringify({ repairs: [repair('a', '2', 'succeeded')] })))
  await act(async () => { initial.resolve([]); start.resolve(repair('a')) })
  expect(current.repairs[0].status).toBe('succeeded')
  act(() => { connection.options.onMessage('{bad'); connection.options.onMessage('{}') })
  expect(current.repairs[0].status).toBe('succeeded')
  act(() => connection.options.onMessage(JSON.stringify({ repairs: [] })))
  expect(current.repairs).toEqual([])
  await act(async () => root.render(<Host feature="b" />))
  expect(connection.close).toHaveBeenCalledTimes(1)
  act(() => connection.options.onMessage(JSON.stringify({ repairs: [repair('a')] })))
  expect(current.repairs).toEqual([])
})

it('shows current failure, allows retry, and expires captured starts and settlements on teardown', async () => {
  api.startDiscoveryRepair.mockRejectedValueOnce(new Error('offline'))
  await act(async () => root.render(<Host feature="a" />))
  await act(async () => { void current.start() })
  expect(current.startError).toBe('offline')
  const pending = deferred<DiscoveryRepairView>()
  api.startDiscoveryRepair.mockReturnValueOnce(pending.promise)
  await act(async () => { void current.start() })
  const expired = current.start
  await act(async () => root.render(null))
  await act(async () => { pending.resolve(repair('a')); await expired() })
  expect(api.startDiscoveryRepair).toHaveBeenCalledTimes(2)
  expect(connections[0].close).toHaveBeenCalledTimes(1)
})
