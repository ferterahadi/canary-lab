// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AuditEntry, JournalEntry, RunStatus } from '@/shared/api/types'
import { InvalidationProvider, useInvalidation } from '@/shared/state/invalidation'
import { JournalTab } from '../components/JournalTab'
import { useExternalAudit } from './use-external-audit'
import { useRunJournal } from './use-run-journal'
const api = vi.hoisted(() => ({ listJournal: vi.fn(), getRunAudit: vi.fn(), connection: 'live' }))
vi.mock('@/shared/api/client', async (original) => ({ ...await original<typeof import('@/shared/api/client')>(), listJournal: api.listJournal, getRunAudit: api.getRunAudit }))
vi.mock('./RunsContext', () => ({ useRuns: () => ({ connection: api.connection }) }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root
let element: HTMLDivElement
let sequence = 0
let id: string
let invalidate: () => void
let journal: ReturnType<typeof useRunJournal>
const entry = (text: string, outcome = 'pending'): JournalEntry => ({ iteration: 1, timestamp: '2026-01-01T00:00:00Z', feature: 'synthetic', run: id, outcome, hypothesis: text, body: `- hypothesis: ${text}` })
const auditEntry = (action: string): AuditEntry => ({ ts: '2026-01-01T00:00:00Z', sessionId: null, clientKind: null, action })
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done }); return { promise, resolve } }
function Journal({ runId = id, feature = 'synthetic' }: { runId?: string; feature?: string }) {
  journal = useRunJournal(feature, runId)
  const bus = useInvalidation()
  invalidate = () => bus.invalidate('journal', runId)
  return <output>{journal.value?.map((e) => e.body).join('|') ?? 'unknown'}</output>
}
function Audit({ runId = id, status = 'running' }: { runId?: string; status?: RunStatus }) {
  return <output>{useExternalAudit(runId, status).map((e) => e.action).join('|')}</output>
}
const renderJournal = async (runId = id, feature = 'synthetic') => { await act(async () => root.render(<InvalidationProvider><Journal runId={runId} feature={feature} /></InvalidationProvider>)) }
const renderAudit = async (runId = id, status: RunStatus = 'running') => { await act(async () => root.render(<Audit runId={runId} status={status} />)) }
beforeEach(() => {
  vi.useFakeTimers(); vi.resetAllMocks(); api.connection = 'live'; id = `evidence-${++sequence}`
  element = document.createElement('div'); document.body.appendChild(element); root = createRoot(element)
})
afterEach(() => { act(() => root.unmount()); element.remove(); vi.useRealTimers() })

it('does not let an older journal poll restore pending evidence after accepted completion', async () => {
  const older = deferred<JournalEntry[]>()
  api.listJournal.mockResolvedValueOnce([entry('Old pending')]).mockReturnValueOnce(older.promise).mockResolvedValue([entry('New completed', 'all_tests_passed')])
  await act(async () => root.render(<JournalTab feature="synthetic" runId={id} refreshKey={0} />))
  await act(async () => vi.advanceTimersByTimeAsync(2000))
  await act(async () => root.render(<JournalTab feature="synthetic" runId={id} refreshKey={1} />))
  expect(element.textContent).toContain('New completed')
  await act(async () => older.resolve([entry('Old pending')]))
  expect(element.textContent).toContain('New completed')
  expect(element.textContent).not.toContain('Old pending')
  const count = api.listJournal.mock.calls.length
  await act(async () => vi.advanceTimersByTimeAsync(6000))
  expect(api.listJournal).toHaveBeenCalledTimes(count)
})
it.each(['failure', 'hang'])('recovers an initial journal %s and stops on empty results', async (mode) => {
  if (mode === 'failure') api.listJournal.mockRejectedValueOnce(new Error('offline'))
  else api.listJournal.mockReturnValueOnce(new Promise(() => {}))
  api.listJournal.mockResolvedValue([])
  await renderJournal()
  await act(async () => vi.advanceTimersByTimeAsync(2000))
  expect(journal.value).toEqual([])
  await act(async () => vi.advanceTimersByTimeAsync(6000))
  expect(api.listJournal).toHaveBeenCalledTimes(2)
  api.listJournal.mockResolvedValue([entry('event', 'all_tests_passed')])
  await act(async () => invalidate())
  expect(element.textContent).toContain('event')
})
it('retains the current journal on failure and isolates feature/run replacements', async () => {
  api.listJournal.mockResolvedValue([entry('accepted')])
  await renderJournal()
  api.listJournal.mockRejectedValueOnce(new Error('offline'))
  await act(async () => invalidate())
  expect(journal.error).toBe('offline')
  expect(element.textContent).toContain('accepted')
  const older = deferred<JournalEntry[]>()
  api.listJournal.mockReturnValueOnce(older.promise)
  await act(async () => vi.advanceTimersByTimeAsync(2000))
  api.listJournal.mockResolvedValue([entry('replacement', 'all_tests_passed')])
  await renderJournal(id, 'another-feature')
  await act(async () => older.resolve([entry('stale')]))
  expect(element.textContent).toContain('replacement')
  expect(element.textContent).not.toContain('stale')
})
it('does not let an older audit read remove newer accepted entries', async () => {
  const older = deferred<{ entries: AuditEntry[] }>()
  api.getRunAudit.mockResolvedValueOnce({ entries: [] }).mockReturnValueOnce(older.promise).mockResolvedValue({ entries: [auditEntry('one'), auditEntry('two')] })
  await renderAudit()
  await act(async () => vi.advanceTimersByTimeAsync(4000))
  expect(element.textContent).toBe('one|two')
  await act(async () => older.resolve({ entries: [auditEntry('one')] }))
  expect(element.textContent).toBe('one|two')
})
it.each(['failure', 'hang'])('recovers an initial terminal audit %s and then stops polling', async (mode) => {
  if (mode === 'failure') api.getRunAudit.mockRejectedValueOnce(new Error('offline'))
  else api.getRunAudit.mockReturnValueOnce(new Promise(() => {}))
  api.getRunAudit.mockResolvedValue({ entries: [] })
  await renderAudit(id, 'passed')
  await act(async () => vi.advanceTimersByTimeAsync(8000))
  expect(api.getRunAudit).toHaveBeenCalledTimes(2)
})
it('refreshes audit on terminal transition and connection recovery, then resumes polling when active', async () => {
  api.getRunAudit.mockResolvedValue({ entries: [auditEntry('active')] })
  await renderAudit()
  api.getRunAudit.mockResolvedValue({ entries: [auditEntry('final')] })
  await renderAudit(id, 'passed')
  expect(element.textContent).toBe('final')
  await act(async () => vi.advanceTimersByTimeAsync(6000))
  expect(api.getRunAudit).toHaveBeenCalledTimes(2)
  api.connection = 'reconnecting'; await renderAudit(id, 'passed')
  api.connection = 'live'; api.getRunAudit.mockResolvedValue({ entries: [auditEntry('recovered')] }); await renderAudit(id, 'passed')
  expect(element.textContent).toBe('recovered')
  await renderAudit()
  const count = api.getRunAudit.mock.calls.length
  await act(async () => vi.advanceTimersByTimeAsync(2000))
  expect(api.getRunAudit).toHaveBeenCalledTimes(count + 1)
})
it('retains audit through failure and discards old reads after run replacement and teardown', async () => {
  api.getRunAudit.mockResolvedValueOnce({ entries: [auditEntry('current')] }).mockRejectedValueOnce(new Error('offline'))
  await renderAudit()
  await act(async () => vi.advanceTimersByTimeAsync(2000))
  expect(element.textContent).toBe('current')
  const older = deferred<{ entries: AuditEntry[] }>()
  api.getRunAudit.mockReturnValue(older.promise)
  await act(async () => vi.advanceTimersByTimeAsync(2000))
  await renderAudit(`${id}-next`)
  expect(element.textContent).toBe('')
  await act(async () => root.render(null))
  const count = api.getRunAudit.mock.calls.length
  await act(async () => { older.resolve({ entries: [auditEntry('late')] }); await vi.advanceTimersByTimeAsync(6000) })
  expect(element.textContent).toBe('')
  expect(api.getRunAudit).toHaveBeenCalledTimes(count)
})
