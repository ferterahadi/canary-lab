// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunDetail } from '@shared/run-detail'
import { evidenceKnownTests, stampedEvidenceLifecycleEvents, stampedEvidencePlaybackEvents } from '@shared/__fixtures__/run-evidence'
import { RunDetailColumn } from './RunDetailColumn'

const paneTerminals = vi.hoisted(() => ({ props: [] as Array<{ paneId?: string }> }))

vi.mock('../state/RunsContext', () => ({ useRun: vi.fn() }))
vi.mock(import('@/shared/api/runs'), async (importOriginal) => ({
  ...(await importOriginal()),
  listJournal: vi.fn(async () => []),
  getRunCyclePatch: vi.fn(async () => ({ iteration: 1, patchPath: '/p', diff: '' })),
}))
vi.mock('@/features/evaluation/state/EvaluationExportContext', () => ({
  useEvaluationExportLog: vi.fn(() => ({ log: '', watchTask: vi.fn() })),
  useEvaluationExportLogs: vi.fn(() => ({})),
  useEvaluationExports: vi.fn(() => ({ startExport: vi.fn(), taskForRun: vi.fn(() => null), taskById: vi.fn(() => null), watchTask: vi.fn(), downloadTask: vi.fn(), logsByTaskId: {} })),
}))
vi.mock('@/shared/shell/McpPromoContext', () => ({ useMcpPromo: () => ({ gatePromo: (_a: string, go: () => void) => go() }) }))
vi.mock('@/shared/ui/AgentSessionView', () => ({ AgentSessionView: () => <div>agent session</div> }))
vi.mock('./PaneTerminal', () => ({
  PaneTerminal: (props: { paneId?: string }) => {
    paneTerminals.props.push(props)
    return <div>terminal</div>
  },
}))

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  paneTerminals.props = []
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
})

async function show(detail: RunDetail, props: Partial<Parameters<typeof RunDetailColumn>[0]> = {}) {
  const { useRun } = await import('../state/RunsContext')
  vi.mocked(useRun).mockReturnValue({ detail, transient: null, status: detail.manifest.status, displayStatus: detail.manifest.status, error: null })
  await act(async () => {
    root.render(<RunDetailColumn runId={detail.runId} {...props} />)
    await Promise.resolve()
  })
}

function tabs(): string[] {
  return [...container.querySelectorAll('header nav button')].map((b) => b.textContent ?? '')
}

function click(label: string): void {
  const target = [...container.querySelectorAll('button')].find((b) => b.textContent === label)
  expect(target, label).toBeTruthy()
  act(() => target!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
}

function detailOf(executionType: 'run' | 'verify' | 'boot' = 'run', runId = 'run-1'): RunDetail {
  return {
    runId,
    manifest: {
      runId, executionType, feature: 'storefront', startedAt: '2026-10-08T10:00:00.000Z', endedAt: '2026-10-08T10:10:00.000Z',
      status: 'passed', healCycles: 2, healMode: 'auto', services: [],
    },
    playbackEvents: stampedEvidencePlaybackEvents(),
    lifecycleEvents: stampedEvidenceLifecycleEvents(),
    summary: { complete: true, total: 4, passed: 4, failed: [], knownTests: evidenceKnownTests },
  }
}

describe('run detail tabs', () => {
  it('orders an ordinary run Overview → Run Logs → Services → Heal Agent → Results & Fixes, opening on Overview', async () => {
    await show(detailOf())
    expect(tabs()).toEqual(['Overview', 'Run Logs', 'Services', 'Heal Agent', 'Results & Fixes'])
    expect(container.querySelector('[data-testid="results-tests"]')).toBeNull()
  })

  it('gives a verify run only its overview and results, and a boot session no results', async () => {
    await show(detailOf('verify'))
    expect(tabs()).toEqual(['Overview', 'Results & Fixes'])
    click('Results & Fixes')
    expect(container.querySelector('[data-testid="results-tests"]')).toBeTruthy()
    expect([...container.querySelectorAll('button')].some((b) => b.textContent === 'Run-wide')).toBe(false)
    await show(detailOf('boot', 'boot-1'))
    expect(tabs()).toEqual(['Overview', 'Run Logs', 'Services'])
  })

  it('lands a focused test on its expanded row in Results & Fixes', async () => {
    await show(detailOf(), { focusTest: 'test-case-applies-the-discount' })
    const open = container.querySelector('[data-open]')
    expect(open?.textContent).toContain('applies the discount')
    expect(open?.querySelector('select')?.value).toBe('2')
  })

  it('lands a captured-fixes arrival on the run-wide evidence', async () => {
    await show(detailOf(), { arriveTab: 'changes' })
    expect(container.querySelector('[data-testid="results-run-wide"]')).toBeTruthy()
  })

  it('keeps the reader’s case and cycle across a tab switch, and drops them for another run', async () => {
    await show(detailOf(), { focusTest: 'test-case-applies-the-discount' })
    const select = container.querySelector<HTMLSelectElement>('[data-open] select')!
    act(() => {
      select.value = '1'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    click('Overview')
    click('Results & Fixes')
    expect(container.querySelector<HTMLSelectElement>('[data-open] select')?.value).toBe('1')
    await show(detailOf('run', 'run-2'))
    click('Results & Fixes')
    expect(container.querySelector('[data-open]')).toBeNull()
  })

  it('keeps the Playwright terminal one click inside Results & Fixes', async () => {
    await show(detailOf())
    click('Results & Fixes')
    click('Terminal')
    expect(paneTerminals.props.map((p) => p.paneId)).toContain('playwright')
  })
})
