// @vitest-environment happy-dom
import fs from 'node:fs'
import path from 'node:path'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { RunDetail, RunSummary } from '@shared/run-detail'
import { runIndexEntry } from '@shared/run-index'
import * as runsApi from '@/shared/api/runs'
import { RunsProvider, useRuns } from '@/features/runs/state/RunsContext'
import { RunRow } from '@/features/runs/components/RunRow'
import { featureTestRuns } from '@/shared/lib/feature-test-runs'
import { classifyWaitForHealTask } from '../../../../../web-server/src/mcp/heal-task-wait'
import type { CanaryLabMcpDeps } from '../../../../../web-server/src/mcp/tool-schemas'
import { FakeWebSocket } from '../../../../../../tools/test-helpers/fake-websocket'
import { TestRunPanel } from './TestRunPanel'

// One recorded summary, read by the MCP tool an agent calls and by the two web
// surfaces a human reads. The recording is load-bearing: it was taken after a
// repair cleared every failure while four environment gates stayed skipped, so
// `total - failed` would claim 55 passes. Every surface must say 51 of 55.
// Identities and paths are anonymized; counts and relationships are preserved.
const recorded = JSON.parse(fs.readFileSync(
  path.join(__dirname, '../../../../../web-server/src/features/runs/logic/runtime/__fixtures__/environment-summary.json'),
  'utf8',
)) as RunSummary

vi.mock('@/shared/api/runs', async (original) => ({ ...await original<typeof import('@/shared/api/runs')>(), listRuns: vi.fn(), getRunDetail: vi.fn() }))

const detail: RunDetail = {
  runId: 'run-recorded',
  manifest: { runId: 'run-recorded', feature: 'example', status: 'passed', executionType: 'run', env: 'local', startedAt: '2026-09-17T00:00:00Z', endedAt: '2026-09-17T00:05:00Z', services: [], healCycles: 1 },
  summary: recorded,
  playbackEvents: [], playwrightArtifacts: [], lifecycleEvents: [],
}

function mcpCounts(): { passed: number; totalKnown: number; statusLine: string } {
  const deps = {
    store: { get: () => detail, registry: { get: () => undefined } },
    featuresDir: '/workspace/features',
    projectRoot: '/workspace',
  } as unknown as CanaryLabMcpDeps
  const result = classifyWaitForHealTask(deps, detail.runId, 'session')
  if (!result?.ok || result.value.type !== 'passed') throw new Error('expected a passed wait_for_heal_task result')
  return result.value.counts
}

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  FakeWebSocket.instances = []
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
  vi.mocked(runsApi.listRuns).mockResolvedValue([])
  vi.mocked(runsApi.getRunDetail).mockRejectedValue(new Error('not loaded'))
})
afterEach(() => { act(() => root.unmount()); container.remove() })

function Panel() {
  const store = useRuns({ reconcile: true })
  const runs = featureTestRuns(store.runs, 'example')
  return <TestRunPanel feature="example" featureRuns={runs} runId={runs[0]?.runId} connection={store.connection}
    indexLoaded={store.indexLoaded} indexError={store.indexError} live={false} evidence={{}} awaiting="idle" onOpenRun={() => {}} />
}

it('the MCP wait result, the run row and the flight run hero report the same pass count for one recorded summary', async () => {
  const counts = mcpCounts()
  expect(counts.statusLine).toMatch(/^51\/55 passed,/)
  const fraction = `${counts.passed}/${counts.totalKnown}`

  act(() => root.render(<ul><RunRow run={runIndexEntry(detail.manifest)} detail={detail} onSelect={() => {}} /></ul>))
  expect(container.textContent).toContain(`${fraction} passed`)

  await act(async () => root.render(<RunsProvider WebSocketImpl={FakeWebSocket as unknown as typeof WebSocket}><Panel /></RunsProvider>))
  await act(async () => FakeWebSocket.instances.at(-1)!.fire({ type: 'snapshot', runs: [runIndexEntry(detail.manifest)], details: { [detail.runId]: detail } }))
  const stat = [...container.querySelectorAll('[data-testid="run-hero-stats"] > div')]
    .find((row) => row.querySelector('dt')?.textContent === 'Tests passed')
  expect(stat?.querySelector('dd')?.textContent).toBe(fraction)
})
