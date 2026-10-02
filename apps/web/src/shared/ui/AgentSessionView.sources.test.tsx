// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ConnectAgentSessionOptions } from '@/shared/api/agent-session-socket'
import { AgentSessionView, type AgentSessionSource } from './AgentSessionView'

const mocks = vi.hoisted(() => ({
  getDiscoveryRepairAgentSession: vi.fn(), getAgentSession: vi.fn(),
  getBenchmarkAgentSession: vi.fn(), getPortifyAgentSession: vi.fn(),
  getCoverageAgentSession: vi.fn(), getEvaluationAgentSession: vi.fn(),
  getFlightAgentSession: vi.fn(), getFlightPlanAgentSession: vi.fn(),
}))
const socket = vi.hoisted(() => ({
  connect: vi.fn<(opts: ConnectAgentSessionOptions) => { close(): void }>(),
}))
vi.mock('@/shared/api/discovery-repair', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/shared/api/discovery-repair')>()),
  getDiscoveryRepairAgentSession: mocks.getDiscoveryRepairAgentSession,
}))
vi.mock('@/shared/api/agent-sessions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/shared/api/agent-sessions')>()),
  getAgentSession: mocks.getAgentSession,
}))
vi.mock('@/shared/api/benchmark', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/shared/api/benchmark')>()),
  getBenchmarkAgentSession: mocks.getBenchmarkAgentSession,
}))
vi.mock('@/shared/api/portify', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/shared/api/portify')>()),
  getPortifyAgentSession: mocks.getPortifyAgentSession,
}))
vi.mock('@/shared/api/coverage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/shared/api/coverage')>()),
  getCoverageAgentSession: mocks.getCoverageAgentSession,
  getEvaluationAgentSession: mocks.getEvaluationAgentSession,
}))
vi.mock('@/shared/api/flights', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/shared/api/flights')>()),
  getFlightAgentSession: mocks.getFlightAgentSession,
  getFlightPlanAgentSession: mocks.getFlightPlanAgentSession,
}))
vi.mock('@/shared/api/agent-session-socket', () => ({ connectAgentSessionStream: socket.connect }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const cases: [AgentSessionSource, keyof typeof mocks, string[]][] = [
  [{ kind: 'discovery-repair', taskId: 'repair' }, 'getDiscoveryRepairAgentSession', ['repair']],
  [{ kind: 'run', runId: 'run' }, 'getAgentSession', ['run']],
  [{ kind: 'benchmark', benchmarkId: 'bench' }, 'getBenchmarkAgentSession', ['bench']],
  [{ kind: 'portify', workflowId: 'workflow' }, 'getPortifyAgentSession', ['workflow']],
  [{ kind: 'coverage', jobId: 'job' }, 'getCoverageAgentSession', ['job']],
  [{ kind: 'evaluation', taskId: 'export' }, 'getEvaluationAgentSession', ['export']],
  [{ kind: 'flight', flightId: 'flight', stage: 'specs:2' }, 'getFlightAgentSession', ['flight', 'specs:2']],
  [{ kind: 'flight-plan', taskId: 'plan' }, 'getFlightPlanAgentSession', ['plan']],
]
const event = { kind: 'assistant-message' as const, timestamp: '2026-01-01T00:00:00.000Z', text: 'Snapshot event' }
let root: Root
let container: HTMLDivElement
beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  for (const reader of Object.values(mocks)) reader.mockReset().mockResolvedValue({ agent: 'claude', sessionId: 'session', events: [event] })
  socket.connect.mockReset().mockImplementation(() => ({ close: vi.fn() }))
})
afterEach(() => { act(() => root.unmount()); container.remove() })

it.each(cases)('routes %j to its REST reader and passes the same source to the socket', async (identity, reader, args) => {
  const source = { ...identity, live: true }
  await act(async () => { root.render(<AgentSessionView source={source} />) })
  expect(mocks[reader]).toHaveBeenCalledExactlyOnceWith(...args)
  for (const [name, read] of Object.entries(mocks)) if (name !== reader) expect(read).not.toHaveBeenCalled()
  expect(socket.connect.mock.calls[0][0].source).toBe(source)
  await act(async () => { root.render(null) })
  expect(socket.connect.mock.results[0].value.close).toHaveBeenCalledOnce()
})

it('deduplicates replay and closes the live stream when the same identity switches to history', async () => {
  const source = { kind: 'run' as const, runId: 'transition', live: true }
  await act(async () => { root.render(<AgentSessionView source={source} />) })
  const callbacks = socket.connect.mock.calls[0][0]
  await act(async () => {
    callbacks.onEvent(event)
    callbacks.onEvent({ ...event, text: 'New live event' })
  })
  expect(container.querySelectorAll('.agentts-row')).toHaveLength(2)
  mocks.getAgentSession.mockResolvedValue({ agent: 'claude', sessionId: 'session', events: [event, { ...event, text: 'New live event' }] })
  await act(async () => { root.render(<AgentSessionView source={{ ...source, live: false }} />) })
  expect(socket.connect.mock.results[0].value.close).toHaveBeenCalledOnce()
  expect(socket.connect).toHaveBeenCalledOnce()
  expect(container.querySelector('[data-testid="agent-session-mode"]')?.textContent).toMatch(/^Ended/)
  expect(container.querySelectorAll('.agentts-row')).toHaveLength(2)
})
