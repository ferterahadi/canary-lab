import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { JournalSection, PlaywrightArtifact, PlaywrightPlaybackEvent, RunDetail, RunSummary } from '@shared/run-detail'
import type { PlaywrightArtifactPolicy } from '@shared/configs/playwright-modes'
import type { VerificationDiagnostics } from '@shared/verification'
import { buildRunEvidence } from '@shared/run-evidence'
import { evidenceCases, evidenceKnownTests, evidenceLifecycleEvents, evidencePlaybackEvents, stampedEvidenceLifecycleEvents, stampedEvidencePlaybackEvents } from '@shared/__fixtures__/run-evidence'
import { ApiError } from '@/shared/api/internal'
import { cycleReviewFromPatch, type CycleReviewFile } from '@shared/test-view/cycle-review'
import { InvalidationProvider, useInvalidation } from '@/shared/state/invalidation'
import type { InvalidationTopic } from '@/shared/state/invalidation-bus'
import type { ResultsSelection } from '../utils/results-fixes'
import { ResultsFixesTab, type ResultsView } from './ResultsFixesTab'

vi.mock(import('@/shared/api/runs'), async (importOriginal) => ({
  ...(await importOriginal()),
  listJournal: vi.fn(),
  getRunCycleReview: vi.fn(),
}))

const paneTerminals = vi.hoisted(() => ({ props: [] as Array<{ paneId?: string }> }))
vi.mock('./PaneTerminal', () => ({
  PaneTerminal: (props: { paneId?: string }) => {
    paneTerminals.props.push(props)
    return <div>terminal</div>
  },
}))

// The modal's own rendering is the shared SourceModal's business; what this
// view owns is which source and title it hands over.
vi.mock('@/shared/ui/ActivityLogModal', () => ({
  SourceModal: ({ open, title, source, testId }: { open: boolean; title: string; source: string; testId?: string }) => (
    open ? <div data-testid={testId}><h2>{title}</h2><pre>{source}</pre></div> : null
  ),
}))

let container: HTMLDivElement
let root: Root
let runSeq = 0

beforeEach(async () => {
  const runsApi = await import('@/shared/api/runs')
  vi.mocked(runsApi.listJournal).mockResolvedValue([])
  vi.mocked(runsApi.getRunCycleReview).mockRejectedValue(new ApiError(404, null))
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  paneTerminals.props = []
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.clearAllMocks()
})

// ── The list: one row per test; a row opens that test's dialog. ──

describe('the test list', () => {
  it('shortens Windows locations while retaining the full tooltip', async () => {
    const location = 'C:\\repo\\e2e\\checkout.spec.ts:12:3'
    await mount(detailOf({ playbackEvents: [{ type: 'test-end', time: '2026-01-01T00:00:01.000Z', test: { name: 'checkout', title: 'checkout', location }, status: 'passed', passed: true, durationMs: 10, retry: 0 }] }))
    const label = [...container.querySelectorAll('[title]')].find((node) => node.getAttribute('title') === location)
    expect(label?.textContent).toBe('e2e/checkout.spec.ts:12:3')
  })

  it('numbers each case by its canonical source-order id from knownTests', async () => {
    // The run knows two tests; only the second (by source order) played back.
    // Its badge reads #2 — the stable id — and the first is listed as not run.
    const summary = {
      complete: true, total: 2, passed: 1, failed: [],
      knownTests: [
        { name: 'a.spec.ts:first', title: 'first', location: 'a.spec.ts:5' },
        { name: 'b.spec.ts:second', title: 'second', location: 'b.spec.ts:5' },
      ],
    } as RunSummary
    const playedSecond: PlaywrightPlaybackEvent[] = [
      { type: 'test-begin', time: '2026-01-01T00:00:00.000Z', test: { name: 'b.spec.ts:second', title: 'second', location: 'b.spec.ts:5' } },
      { type: 'test-end', time: '2026-01-01T00:00:01.000Z', test: { name: 'b.spec.ts:second', title: 'second', location: 'b.spec.ts:5' }, status: 'passed', passed: true, durationMs: 10, retry: 0 },
    ]
    await mount(detailOf({ playbackEvents: playedSecond, summary }))
    expect(caseRows().map((r) => r.querySelector(':scope > button')?.textContent)).toEqual(['#1firsta.spec.ts:5not run', '#2secondb.spec.ts:5passed'])
  })

  it('marks the rows of tests that failed first, so a fix is visible without opening each one', async () => {
    await mountStory({ selected: false })
    const marks = caseRows().map((r) => r.querySelector(':scope > button [data-testid="case-recovered"]')?.getAttribute('aria-label') ?? null)
    expect(marks).toEqual(['Failed first · passed after repair 2', 'Failed first · passed after repair 1', null, null])
  })

  it('renders skipped status as warning, not danger, in the row and the timeline', async () => {
    await renderSingle({ events: events.map((e) => e.type === 'test-end' ? { ...e, status: 'skipped', passed: false } : e) })
    // The pill itself, not the corner-mark wrapper that shares its text.
    const pills = [...document.body.querySelectorAll('span')].filter((s) => s.textContent?.toLowerCase() === 'skipped' && s.childElementCount === 0)
    // The row's pill and the timeline's.
    expect(pills.length).toBeGreaterThanOrEqual(2)
    for (const pill of pills) {
      expect(pill.className).toContain('warning')
      expect(pill.className).not.toContain('danger')
    }
  })

  it('opens a test’s dialog from its row, and closes it back to the list', async () => {
    const { selections } = await mountStory({ selected: false })
    expect(dialog()).toBeNull()
    const row = headerOf(discountKey())!
    expect(row.getAttribute('aria-haspopup')).toBe('dialog')
    act(() => row.click())
    expect(selections.at(-1)).toEqual({ caseKey: discountKey(), test: discountTarget })
    expect(dialog()?.textContent).toContain('applies the discount')
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(selections.at(-1)).toEqual({ caseKey: null })
    expect(dialog()).toBeNull()
  })

  it('shows the attempt still running in the row, not the earlier failure', async () => {
    await renderSingle({
      events: [
        { type: 'test-begin', time: '2026-01-01T00:00:00.000Z', test: { name: 'checkout', title: 'checkout failed before heal', location: 'checkout.spec.ts:1' } },
        { type: 'test-end', time: '2026-01-01T00:01:00.000Z', test: { name: 'checkout', title: 'checkout failed before heal', location: 'checkout.spec.ts:1' }, status: 'failed', passed: false, durationMs: 60000, retry: 0, error: { message: 'old failure' } },
        { type: 'test-begin', time: '2026-01-01T00:10:00.000Z', test: { name: 'checkout', title: 'checkout rerun now', location: 'checkout.spec.ts:1' } },
      ],
    })
    expect(caseRows()).toHaveLength(1)
    expect(caseRow()?.textContent).toContain('checkout rerun now')
    expect(caseRow()?.textContent).not.toContain('checkout failed before heal')
    expect(caseRow()?.querySelector('[data-testid="case-recovered"]')?.getAttribute('aria-label')).toBe('Failed first · running again')
    // The dialog opens on the run in progress; the earlier failure is one pick away.
    expect(timeline()).toEqual(['Run againRunning', 'Initial runFailed'])
    expect(section('section-result')?.textContent).toContain('Still running. The result appears here when this execution finishes.')
    expect(dialog()?.textContent).not.toContain('old failure')
  })

  it('puts artifact settings beside the evidence they decide, in the Artifacts tab', async () => {
    const onSettings = vi.fn()
    await mount(detailOf({ playbackEvents: events }), { onOpenArtifactSettings: onSettings, selection: { caseKey: buildRunEvidence({ events }).cases[0].caseKey, tab: 'artifacts' } })
    const settings = [...document.body.querySelectorAll('button')].filter((b) => b.textContent?.includes('Artifact settings'))
    expect(settings).toHaveLength(1)
    expect(document.body.querySelector('[data-testid="attempt-evidence"]')?.contains(settings[0])).toBe(true)
    act(() => settings[0].click())
    expect(onSettings).toHaveBeenCalledOnce()
  })

  it('names a linked test this run did not record', async () => {
    await mount(detailOf({ playbackEvents: events }), { unmatchedTest: 'gone' })
    expect(container.querySelector('[data-testid="stale-test-link"]')?.textContent).toContain('This link names a test this run did not record (gone).')
  })
})

describe('the run’s other views and leftovers', () => {
  it('shows the Playwright terminal as its own view, with no dialog over it', async () => {
    const { views } = await mount(detailOf({ playbackEvents: events }), { selection: { caseKey: buildRunEvidence({ events }).cases[0].caseKey } })
    expect(dialog()).not.toBeNull()
    expect([...container.querySelectorAll('button')].map((b) => b.textContent).slice(0, 2)).toEqual(['Formatted', 'Playwright'])
    act(() => { [...container.querySelectorAll('button')].find((b) => b.textContent === 'Playwright')!.click() })
    expect(views).toEqual(['terminal'])
    expect(paneTerminals.props.map((p) => p.paneId)).toEqual(['playwright'])
    expect(dialog()).toBeNull()
  })

  it('offers a verify run its diagnostics beside its results', async () => {
    const diagnostics: VerificationDiagnostics = { generatedAt: '2026-01-01T00:00:00.000Z', summary: 'Remote target returned 500.', targetUrls: {}, failedTests: [] }
    await mount(detailOf({ playbackEvents: events }), { diagnostics })
    expect(container.textContent).toContain('Remote target returned 500. Verify does not edit code or start a heal cycle.')
    expect(caseRows()).toHaveLength(1)
  })

  it('says so when the run recorded no test at all', async () => {
    await mount(detailOf({}))
    expect(container.textContent).toContain('No playback events captured')
  })

  it('keeps files no test claimed reachable below the list', async () => {
    const unassigned = { ...artifact('screenshot', 'orphan.png'), execution: 2 }
    await mount(detailOf({
      playbackEvents: stampedEvidencePlaybackEvents(), lifecycleEvents: stampedEvidenceLifecycleEvents(),
      summary: { complete: true, total: 4, passed: 4, failed: [], knownTests: evidenceKnownTests }, unassignedArtifacts: [unassigned],
    }))
    const list = container.querySelector('[data-testid="unassigned-artifacts"]')
    expect(list?.querySelector('a')?.getAttribute('href')).toBe('/artifacts/orphan.png')
    expect(list?.textContent).toContain('execution 2 · screenshot')
  })

  it('lists results recorded outside every known execution', async () => {
    await mount(detailOf({ playbackEvents: events, lifecycleEvents: [{ phase: 'running-tests', headline: 'x', updatedAt: '2026-01-02T00:00:00.000Z' }] }))
    expect(container.querySelector('[data-testid="unplaced-attempts"]')?.textContent).toContain('passed checkout')
  })
})

// ── The dialog's frame: a timeline, newest first, and two tabs. ──

describe('the test dialog', () => {
  it('lists every run of a repaired test newest first, and opens on the latest', async () => {
    await mountStory()
    // Numbered by source order across the roster: admin.spec sorts first.
    expect(dialog()?.textContent).toContain('Test #2')
    expect(timeline()).toEqual([
      'Repair 2Passed',
      'Repair 1Failed',
      'Initial runFailed',
    ])
    expect(entryButtons()[0].getAttribute('aria-pressed')).toBe('true')
    expect(selectedTab()).toBe('Summary')
    expect(cards()).toEqual(['Repair 2: what changed', 'Repair 2: test result'])
    expect(section('section-result')?.textContent).toContain('Passed. The assertion held after this repair.')
  })

  it('carries result chips in the timeline only', async () => {
    await mountStory()
    const chips = [...dialog()!.querySelectorAll('span')].filter((s) => ['Passed', 'Failed'].includes(s.textContent ?? '') && s.childElementCount === 0)
    expect(chips).toHaveLength(3)
    expect(chips.every((chip) => chip.closest('aside'))).toBe(true)
  })

  it('moves the summary to a picked run, dropping an older link’s cycle and journal', async () => {
    const { selections } = await mount(storyDetail(), { selection: { caseKey: discountKey(), cycle: 2, journal: 'entry' } })
    act(() => entryButtons()[1].click())
    expect(selections.at(-1)).toEqual({ caseKey: discountKey(), attempt: 2 })
    expect(cards()).toEqual(['Repair 1: what changed', 'Repair 1: test result'])
    expect(section('section-error')?.textContent).toContain('Expected total 90, received 95')
  })

  it('shows the first run as its result alone, with no repair sections', async () => {
    await mountStory({ attempt: 1 })
    expect(cards()).toEqual(['Initial run: test result'])
    expect(section('section-error')?.textContent).toContain('Expected total 90, received 100')
    expect(section('section-notes')).toBeNull()
    expect(section('section-changes')).toBeNull()
  })

  it('opens a routed repair cycle on the run that checked it', async () => {
    await mountStory({ cycle: 1 })
    expect(entryButtons()[1].getAttribute('aria-pressed')).toBe('true')
    expect(cards()).toEqual(['Repair 1: what changed', 'Repair 1: test result'])
  })

  it('says which run a stale link asked for instead of swapping it silently', async () => {
    await mountStory({ attempt: 9 })
    expect(document.body.querySelector('[data-testid="stale-entry-link"]')?.textContent).toBe('This test has no run 9; showing its latest run.')
    expect(entryButtons()[0].getAttribute('aria-pressed')).toBe('true')
    act(() => { root.unmount() })
    root = createRoot(container)
    await mountStory({ cycle: 5 })
    expect(document.body.querySelector('[data-testid="stale-entry-link"]')?.textContent).toBe('Repair 5 did not address this test; showing its latest run.')
  })

  it('keeps the picked run when the tab changes', async () => {
    const { selections } = await mountStory({ attempt: 2 })
    act(() => tab('Artifacts')!.click())
    expect(selections.at(-1)).toEqual({ caseKey: discountKey(), attempt: 2, tab: 'artifacts' })
    expect(entryButtons()[1].getAttribute('aria-pressed')).toBe('true')
    expect(dialog()?.querySelector('[data-testid="attempt-evidence"]')).not.toBeNull()
  })

  it('opens a clean first-time pass on its evidence, since there is nothing to summarise', async () => {
    await renderSingle()
    expect(timeline()).toEqual(['Initial runPassedno repair needed'])
    expect(selectedTab()).toBe('Artifacts')
    act(() => tab('Summary')!.click())
    expect(section('summary-empty')?.textContent).toContain('No failure to explain')
  })

  it('keeps its tab while the run settles under it', async () => {
    const running: PlaywrightPlaybackEvent[] = [events[0]]
    const { rerender } = await mountLive(detailOf({ playbackEvents: running }), { selection: { caseKey: buildRunEvidence({ events: running }).cases[0].caseKey } })
    expect(selectedTab()).toBe('Summary')
    expect(section('summary-empty')?.textContent).toContain('Still running')
    // The same run, pushed again once the test passed.
    await rerender(detailOf({ playbackEvents: events }))
    expect(selectedTab()).toBe('Summary')
    expect(section('summary-empty')?.textContent).toContain('No failure to explain')
  })

  it('names a pass on a runner retry, and points at the attempt that failed', async () => {
    const retried: PlaywrightPlaybackEvent[] = [
      ...failedWith('TypeError: boom'),
      { type: 'test-begin', time: '2026-01-01T00:00:06.000Z', test: { name: 'checkout', title: 'passed checkout', location: 'checkout.spec.ts:1' } },
      { type: 'test-end', time: '2026-01-01T00:00:07.000Z', test: { name: 'checkout', title: 'passed checkout', location: 'checkout.spec.ts:1' }, status: 'passed', passed: true, durationMs: 10, retry: 1 },
    ]
    await renderSingle({ events: retried })
    expect(timeline()).toEqual(['Retry 1Passed', 'Initial runFailed'])
    expect(caseRow()?.querySelector('[data-testid="case-recovered"]')?.getAttribute('aria-label')).toBe('Failed first · passed on retry')
    expect(section('summary-empty')?.textContent).toContain('No failure in this attempt')
  })

  it('opens a test that never ran on one entry that says so in both tabs', async () => {
    const summary = { complete: true, total: 1, passed: 0, failed: [], knownTests: [{ name: 'never', title: 'never', location: 'n.spec.ts:1' }] } as RunSummary
    await mount(detailOf({ playbackEvents: [], summary }), { selection: { caseKey: buildRunEvidence({ events: [], known: summary.knownTests }).cases[0].caseKey } })
    expect(timeline()).toEqual(['Not runNot runnot in this run yet'])
    expect(section('summary-empty')?.textContent).toContain('Not run in this run')
    act(() => tab('Artifacts')!.click())
    expect(section('artifacts-empty')?.textContent).toContain('Not run in this run')
  })

  it('gives a repair the runner has not checked yet its own entry, with nothing invented under it', async () => {
    await mountStory({ lifecycle: stampedEvidenceLifecycleEvents().slice(0, 6), events: stampedEvidencePlaybackEvents().filter((e) => e.time < '2026-10-08T10:09:00.000Z') })
    expect(timeline()[0]).toBe('Repair 2Pendingwaiting for the runner')
    expect(cards()).toEqual(['Repair 2: what changed', 'Repair 2: test result'])
    expect(section('section-result')?.textContent).toContain('Not run again yet. The runner checks this repair in its next execution.')
    act(() => tab('Artifacts')!.click())
    expect(section('artifacts-empty')?.textContent).toContain('Nothing recorded yet')
  })

  it('says a run the runner stopped mid-test was stopped, and pairs the next run with its own result', async () => {
    const t = { id: 'checkout-id', name: 'checkout', title: 'checkout', location: 'checkout.spec.ts:1' }
    await renderSingle({
      events: [
        { type: 'test-begin', time: '2026-01-01T00:00:00.000Z', test: t },
        { type: 'test-begin', time: '2026-01-01T00:10:00.000Z', test: t },
        { type: 'test-end', time: '2026-01-01T00:11:00.000Z', test: t, status: 'passed', passed: true, durationMs: 1, retry: 0 },
      ],
    })
    expect(timeline()).toEqual(['Run againPassed', 'Initial runStopped'])
    act(() => entryButtons()[1].click())
    act(() => tab('Summary')!.click())
    expect(section('section-result')?.textContent).toContain('Stopped before it finished. The run was stopped while this test was running, so it has no result.')
  })

  it('says a skipped run recorded no reason', async () => {
    await renderSingle({ events: events.map((e) => e.type === 'test-end' ? { ...e, status: 'skipped', passed: false } : e) })
    expect(section('section-result')?.textContent).toContain('Skipped. Playwright recorded no reason for the skip.')
  })
})

describe('a failed run’s error', () => {
  it('leads a matcher failure with its mismatch, and carries the matcher as the title caption', async () => {
    await renderSingle({ events: failedWith('Error: expect(received).toBe(expected) // Object.is equality\n\nExpected: "ready"\nReceived: "broken"') })
    const error = section('section-error')!
    expect(error.querySelector('[data-testid="failure-message"]')).toBeNull()
    expect(error.querySelector('[data-testid="expected-value"]')?.textContent).toBe('"ready"')
    expect(error.querySelector('[data-testid="received-value"]')?.textContent).toBe('"broken"')
    expect(error.querySelector('header')?.textContent).toBe('Initial run: test resulttoBe · Object.is equality')
  })

  it('leads with a custom message, without its Error prefix, and the mismatch under it', async () => {
    await renderSingle({ events: failedWith('Error: run started off minute 17\n\nexpect(received).toBe(expected) // Object.is equality\n\nExpected: "0"\nReceived: "1"') })
    const error = section('section-error')!
    expect([...error.querySelectorAll('dt')].map((n) => n.textContent)).toEqual(['Failure'])
    expect(error.querySelector('[data-testid="failure-message"]')?.textContent).toBe('run started off minute 17')
    expect(error.querySelector('[data-testid="received-value"]')?.textContent).toBe('"1"')
  })

  it('keeps a message it cannot split verbatim', async () => {
    await renderSingle({ events: failedWith('TypeError: boom') })
    expect(section('section-error')?.querySelector('pre')?.textContent).toBe('TypeError: boom')
  })

  it('shows the code frame in the Tests column editor, numbered by source line, with the failing line marked', async () => {
    await renderSingle({ events: failedWith('Error: total is off\n\nexpect(received).toBe(expected) // Object.is equality\n\nExpected: 90\nReceived: 95', '  11 |   const total = sum()\n> 12 |   await expect(total).toBe(90)\n     |         ^') })
    const error = section('section-error')!
    // The matcher moves from the title to the Code band it describes.
    expect(error.querySelector('header')?.textContent).toBe('Initial run: test result')
    const band = error.querySelector('[data-testid="error-code-frame"]')!.parentElement!.parentElement!
    expect(band.firstElementChild?.textContent).toBe('Codecheckout.spec.ts:12toBe · Object.is equality')
    const lines = [...error.querySelectorAll('[data-testid="error-code-frame"] .line')]
    expect(lines.map((line) => line.getAttribute('data-code-sequence-label'))).toEqual(['11', '12'])
    expect(lines.map((line) => line.getAttribute('data-execution-highlight'))).toEqual([null, 'failed'])
    expect(lines[1].textContent).toBe('  await expect(total).toBe(90)FAILED HERE')
  })

  it('keeps a snippet that is not a code frame verbatim', async () => {
    await renderSingle({ events: failedWith('TypeError: boom', 'at checkout.spec.ts:12') })
    expect([...section('section-error')!.querySelectorAll('pre')].map((pre) => pre.textContent)).toEqual(['TypeError: boom', 'at checkout.spec.ts:12'])
  })

  it('keeps context after the pair as its own row', async () => {
    await renderSingle({ events: failedWith('Error: total is off\nExpected: 90\nReceived: 95\nTimeout 5000ms exceeded.') })
    expect([...section('section-error')!.querySelectorAll('dt')].map((n) => n.textContent)).toEqual(['Failure', 'Details'])
    expect(section('section-error')?.querySelector('header')?.textContent).toBe('Initial run: test result')
  })

  it('says when the runner recorded no message for a failure', async () => {
    await renderSingle({ events: events.map((e) => e.type === 'test-end' ? { ...e, status: 'failed', passed: false } : e) })
    expect(section('section-error')?.textContent).toContain('Playwright recorded no error message for this failure.')
  })
})

// ── Artifacts: the selected run's own evidence, steps first. ──

describe('a run’s artifacts', () => {
  it('opens on the steps, with the trace at the end of the evidence bar', async () => {
    await renderSingle()
    const panel = evidencePanel()!
    expect(panel.querySelector('[data-testid="evidence-badge-steps"]')?.textContent).toBe('2')
    expect(panel.textContent).toContain('Opened /en_SG')
    expect(panel.textContent).toContain('Clicked Redeem')
    const trace = panel.querySelector('a[download="trace.zip"]')
    expect(trace?.getAttribute('aria-label')).toBe('Download trace')
    expect(trace?.textContent).toBe('Trace')
    expect(trace?.querySelector('svg')).toBeTruthy()
    expect(trace?.className).toContain('truncate')
    expect(trace?.className).toContain('max-w-full')
    expect(panel.querySelector('img')).toBeNull()
  })

  it('numbers each step by its spec line, names a helper’s file, and folds a loop into one row', async () => {
    const test = { name: 'checkout', title: 'passed checkout', location: '/repo/e2e/ledger.spec.ts:30' }
    const step = (title: string, location: string): PlaywrightPlaybackEvent[] => ['step-begin' as const, 'step-end' as const].map((type) => ({ type, time: '2026-01-01T00:00:01.000Z', test: { name: test.name, title: test.title }, step: { title, category: 'expect', location } }))
    const ids = Array.from({ length: 30 }, (_, i) => `${String(i).padStart(2, '0')}${'f'.repeat(62)}`)
    await renderSingle({ events: [
      { type: 'test-begin', time: '2026-01-01T00:00:00.000Z', test },
      ...step('Expect "toBe"', '/repo/e2e/support/staging.ts:41'),
      ...ids.flatMap((id) => step(id, '/repo/e2e/ledger.spec.ts:77')),
      { type: 'test-end', time: '2026-01-01T00:00:05.000Z', test, status: 'passed', passed: true, durationMs: 10, retry: 0 },
    ] })
    const rows = [...evidencePanel()!.querySelectorAll('[data-testid="evidence-step"]')]
    expect(rows.map((r) => r.querySelector('[data-testid="evidence-step-line"]')?.textContent)).toEqual(['41', '77'])
    expect(rows[0].textContent).toContain('staging.ts')
    expect(rows[1].textContent).toContain('Verified the same check 30 times×30')
    expect(rows[1].textContent).not.toContain('ledger.spec.ts')
    expect(evidencePanel()?.querySelector('[data-testid="evidence-badge-steps"]')?.textContent).toBe('2')
    const toggle = rows[1].querySelector<HTMLButtonElement>('[data-testid="evidence-step-labels-toggle"]')!
    act(() => toggle.click())
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    const labels = () => [...rows[1].querySelectorAll('[data-testid="evidence-step-labels"] span')]
    expect(labels()).toHaveLength(24)
    expect(labels()[0].textContent).toBe('00ffffffffff…')
    expect(labels()[0].getAttribute('title')).toBe(ids[0])
    act(() => [...rows[1].querySelectorAll('button')].find((b) => b.textContent === 'Show all 30')!.click())
    expect(labels()).toHaveLength(30)
    act(() => [...rows[1].querySelectorAll('button')].find((b) => b.textContent === 'Show fewer')!.click())
    expect(labels()).toHaveLength(24)
    act(() => toggle.click())
    expect(rows[1].querySelector('[data-testid="evidence-step-labels"]')).toBeNull()
  })

  it('drops the line gutter when no step recorded where it ran', async () => {
    await renderSingle()
    const rows = [...evidencePanel()!.querySelectorAll('[data-testid="evidence-step"]')]
    expect(rows).toHaveLength(2)
    expect(evidencePanel()!.querySelector('[data-testid="evidence-step-line"]')).toBeNull()
    expect(rows[0].firstElementChild?.className).toContain('grid-cols-[minmax(0,1fr)_auto]')
  })

  it('lists a loop’s sentence labels in full rather than shortening them', async () => {
    const test = { name: 'checkout', title: 'passed checkout', location: '/repo/e2e/ledger.spec.ts:30' }
    const step = (title: string, line: number): PlaywrightPlaybackEvent => ({ type: 'step-begin', time: '2026-01-01T00:00:01.000Z', test: { name: test.name, title: test.title }, step: { title, category: 'expect', location: `/repo/e2e/ledger.spec.ts:${line}` } })
    await renderSingle({ events: [
      { type: 'test-begin', time: '2026-01-01T00:00:00.000Z', test },
      step('SETTLE_WINDOW runs started in the hour 13:00', 94), step('SETTLE_WINDOW run in the hour 13:00 started off minute 17', 98),
      step('SETTLE_WINDOW runs started in the hour 14:00', 94), step('SETTLE_WINDOW run in the hour 14:00 started off minute 17', 98),
      { type: 'test-end', time: '2026-01-01T00:00:05.000Z', test, status: 'passed', passed: true, durationMs: 10, retry: 0 },
    ] })
    const rows = [...evidencePanel()!.querySelectorAll('[data-testid="evidence-step"]')]
    expect(rows.map((r) => r.querySelector('[data-testid="evidence-step-line"]')?.textContent)).toEqual(['94', '98'])
    act(() => rows[0].querySelector<HTMLButtonElement>('[data-testid="evidence-step-labels-toggle"]')!.click())
    expect([...rows[0].querySelectorAll('[data-testid="evidence-step-labels"] li')].map((li) => li.textContent)).toEqual(['SETTLE_WINDOW runs started in the hour 13:00', 'SETTLE_WINDOW runs started in the hour 14:00'])
  })

  it('keeps one evidence panel open at a time', async () => {
    await renderSingle()
    act(() => evidenceTab('screenshot')!.click())
    expect(evidencePanel()?.querySelector('img')?.getAttribute('alt')).toBe('Final page screenshot')
    expect(evidenceTab('screenshot')?.getAttribute('aria-selected')).toBe('true')
    expect(evidencePanel()?.textContent).not.toContain('Opened /en_SG')
    act(() => evidenceTab('steps')!.click())
    expect(evidencePanel()?.textContent).toContain('Opened /en_SG')
    expect(evidencePanel()?.querySelector('img')).toBeNull()
  })

  it('plays retained video in place', async () => {
    await renderSingle()
    act(() => evidenceTab('video')!.click())
    expect(evidencePanel()?.querySelector('video')?.getAttribute('src')).toBe('/artifacts/video.webm')
  })

  it('lists every step, past the eighth', async () => {
    await renderSingle({ events: manyActionEvents })
    expect(evidencePanel()?.querySelector('[data-testid="evidence-badge-steps"]')?.textContent).toBe('10')
    expect(evidencePanel()?.textContent).toContain('Clicked Continue')
    expect(evidencePanel()?.textContent).toContain('Verified Order confirmed')
  })

  it('keeps the trace when no screenshot is retained, and says why there is none', async () => {
    await renderSingle({ artifacts: [artifact('trace', 'trace.zip'), artifact('video', 'video.webm')] })
    expect(evidencePanel()?.querySelector('[data-testid="evidence-badge-screenshot"]')?.textContent).toBe('None')
    expect(evidencePanel()?.querySelector('a[download="trace.zip"]')).toBeTruthy()
    act(() => evidenceTab('screenshot')!.click())
    expect(evidencePanel()?.textContent).toContain('No screenshot for this run')
    expect(evidencePanel()?.textContent).toContain('Playwright kept no screenshot for this run.')
  })

  it('says video was off for the run, in the policy’s terms', async () => {
    await renderSingle({ artifacts: [artifact('screenshot', 'canary-lab-final-page-checkout.png'), artifact('trace', 'trace.zip')], policy: { screenshot: 'on', trace: 'on', video: 'off' } })
    expect(evidencePanel()?.querySelector('[data-testid="evidence-badge-video"]')?.textContent).toBe('Off')
    act(() => evidenceTab('video')!.click())
    expect(evidencePanel()?.textContent).toContain('Video recording was off for this run, so Playwright kept none.')
  })

  it('says why a stamped run has no media instead of borrowing a name match', async () => {
    await mountStory({ tab: 'artifacts' })
    act(() => evidenceTab('screenshot')!.click())
    expect(evidencePanel()?.textContent).toContain('No screenshot, video or trace was retained for this execution.')
  })

  it('shows the picked run’s own retained media, and resets to its steps when the run changes', async () => {
    const discount = storyEvidence().cases.find((c) => c.caseKey === discountKey())!
    await mountStory({ tab: 'artifacts', attempt: 2, attemptArtifacts: {
      [discount.attempts[1].attemptKey]: [artifact('screenshot', 'exec-2.png')],
      [discount.attempts[0].attemptKey]: [artifact('screenshot', 'exec-1.png')],
    } })
    act(() => evidenceTab('screenshot')!.click())
    expect(evidencePanel()?.querySelector('img')?.getAttribute('src')).toBe('/artifacts/exec-2.png')
    act(() => entryButtons()[2].click())
    expect(evidencePanel()?.querySelector('img')).toBeNull()
    expect(evidenceTab('steps')?.getAttribute('aria-selected')).toBe('true')
    act(() => evidenceTab('screenshot')!.click())
    expect(evidencePanel()?.querySelector('img')?.getAttribute('src')).toBe('/artifacts/exec-1.png')
  })

  it('says media is still being saved for an execution that has not finished', async () => {
    await mountStory({ tab: 'artifacts', lifecycle: stampedEvidenceLifecycleEvents().slice(0, 7) })
    act(() => evidenceTab('screenshot')!.click())
    expect(evidencePanel()?.textContent).toContain('No screenshot yet')
    expect(evidencePanel()?.textContent).toContain('This one is still running, so they appear once it finishes.')
  })

  describe('a run recorded before executions were stamped', () => {
    const legacyDetail = () => detailOf({
      playbackEvents: evidencePlaybackEvents, lifecycleEvents: evidenceLifecycleEvents,
      summary: { complete: true, total: 4, passed: 4, failed: [], knownTests: evidenceKnownTests },
      playwrightArtifacts: [
        { testName: evidenceCases.discount.name, artifacts: [artifact('screenshot', 'discount-latest.png')] },
        { testName: evidenceCases.homeLoads.name, artifacts: [artifact('screenshot', 'loads-latest.png')] },
      ],
      manifest: { healCycles: 2, playwrightArtifacts: { screenshot: 'on', trace: 'on', video: 'off' } },
    })
    const legacyKey = (location: string) => buildRunEvidence({ events: evidencePlaybackEvents, known: evidenceKnownTests, lifecycle: evidenceLifecycleEvents })
      .cases.find((c) => c.location === location)!.caseKey

    it('shows its one kept copy on the latest run only, and says why earlier runs have none', async () => {
      await mount(legacyDetail(), { selection: { caseKey: legacyKey(evidenceCases.discount.location), tab: 'artifacts' } })
      act(() => evidenceTab('screenshot')!.click())
      expect(evidencePanel()?.querySelector('img')?.getAttribute('src')).toBe('/artifacts/discount-latest.png')
      act(() => entryButtons()[2].click())
      act(() => evidenceTab('screenshot')!.click())
      expect(evidencePanel()?.textContent).toContain('Not retained: this run kept one copy per test, and a later attempt replaced it.')
    })

    it('refuses a kept copy two same-name tests could own', async () => {
      await mount(legacyDetail(), { selection: { caseKey: legacyKey(evidenceCases.homeLoads.location), tab: 'artifacts' } })
      expect(evidencePanel()?.querySelector('[data-testid="evidence-badge-screenshot"]')?.textContent).toBe('None')
      act(() => evidenceTab('screenshot')!.click())
      expect(evidencePanel()?.textContent).toContain('Not shown: another test with the same name could own the retained copy.')
    })
  })
})

describe('repair notes and code changes', () => {
  it('reads the cycle’s own journal entry and opens it and the whole journal in full', async () => {
    const { selections } = await mountStory({ journal: journalSections() })
    expect(section('section-notes')?.textContent).toContain('the discount is 10 percent, not 5')
    act(() => { button('Open entry')?.click() })
    expect(selections.at(-1)?.journal).toBe('entry')
    expect(document.querySelector('[data-testid="journal-source-modal"]')?.textContent).toBe(`Iteration 2${journalSections()[0].body}`)
    act(() => { button('Run journal')?.click() })
    const full = document.querySelector('[data-testid="journal-source-modal"]')?.textContent ?? ''
    expect(full.startsWith('Full run journal## Iteration 1')).toBe(true)
    expect(full).toContain('## Iteration 2')
  })

  it('says when a cycle entry covered several tests', async () => {
    await mountStory({ journal: journalSections(), attempt: 2 })
    expect(section('section-notes')?.querySelector('[role="button"]')?.getAttribute('aria-label')).toContain("This repair's entry covers 2 tests.")
  })

  it('leads each field with its first sentence and bounds the rest, keeping every line in the full entry', async () => {
    const steps = Array.from({ length: 40 }, (_, i) => `step ${i + 1} of the investigation`).join('; ')
    const [latest, earlier] = journalSections()
    await mountStory({ journal: [{ ...latest, body: `\n- hypothesis: The total is wrong. ${steps}\n- fix.description: multiply by 0.9\n` }, earlier] })
    const lines = [...section('section-notes')!.querySelectorAll<HTMLElement>('[data-testid="journal-excerpt"] p')]
    expect(lines.map((p) => p.textContent)).toEqual(['The total is wrong.', expect.stringMatching(/^step 1 of the investigation/), 'multiply by 0.9'])
    expect(lines.every((p) => p.className.includes('line-clamp-2'))).toBe(true)
    act(() => { button('Open entry')?.click() })
    expect(document.querySelector('[data-testid="journal-source-modal"]')?.textContent).toContain('step 40 of the investigation')
  })

  it('says when an entry records no hypothesis or fix, and still opens it', async () => {
    const [latest, earlier] = journalSections()
    await mountStory({ journal: [{ ...latest, body: '\n- outcome: all_tests_passed\n' }, earlier] })
    expect(section('section-notes')?.textContent).toContain('This cycle\'s journal entry records no hypothesis or fix.')
    act(() => { button('Open entry')?.click() })
    expect(document.querySelector('[data-testid="journal-source-modal"]')?.textContent).toContain('outcome: all_tests_passed')
  })

  it('names an entry matched by order because it predates cycle stamps', async () => {
    const legacy = journalSections().map(({ cycle: _cycle, inputExecution: _input, failingTests: _tests, ...rest }) => rest)
    await mountStory({ journal: legacy })
    expect(section('section-notes')?.querySelector('[role="button"]')?.getAttribute('aria-label')).toContain('Matched to this repair by entry order; the entry predates repair numbers.')
  })

  it('reports a journal it could not read, and offers no full journal', async () => {
    const runsApi = await import('@/shared/api/runs')
    vi.mocked(runsApi.listJournal).mockRejectedValue(new Error('EACCES'))
    await mountStory()
    expect(section('section-notes')?.textContent).toContain('The journal couldn\'t be read: EACCES')
    expect(button('Run journal')).toBeUndefined()
  })

  it('names a cycle with no journal entry instead of inventing notes or a patch', async () => {
    await mountStory({ journal: [] })
    expect(section('section-notes')?.textContent).toContain('The agent wrote no journal entry for this cycle.')
    expect(section('section-changes')?.textContent).toContain('No patch is linked to this cycle.')
  })

  it('shows the cycle’s retained patch file by file, with real line numbers and only the changed words marked', async () => {
    const runsApi = await import('@/shared/api/runs')
    const files = cycleReviewFromPatch(`${patch('0.95', '0.9')}\n${supportPatch()}`)
    vi.mocked(runsApi.getRunCycleReview).mockResolvedValue({ iteration: 2, source: 'patch', patchPath: '/runs/r/diffs/iteration-2.patch', truncated: false, healMode: 'service', files })
    await mountStory({ journal: journalSections() })
    expect(runsApi.getRunCycleReview).toHaveBeenCalledWith(expect.any(String), 2)
    const changes = section('section-changes')!
    const table = changes.querySelector('table[aria-label="Code changes before and after"]')!
    expect([...table.querySelectorAll('th')].map((cell) => cell.textContent)).toEqual(['Before repair 2', 'After repair 2'])
    expect([...table.querySelectorAll('[data-side="after"]')].map((line) => line.getAttribute('data-source-line'))).toEqual(['12'])
    expect([...table.querySelectorAll('.cl-context-line')].map((cell) => cell.textContent)).toEqual(['12', '12'])
    expect([...table.querySelectorAll('[data-side="after"] mark.cl-review-word')].map((mark) => mark.textContent)).toEqual(['9'])
    expect(table.querySelector('.cl-comparison-section')?.textContent).toBe('11 unchanged lines not in this patch')
    expect(changes.textContent).not.toContain('Empty value')
    expect(changes.querySelector('.cl-lang-switch')?.getAttribute('aria-disabled')).toBe('true')

    const picker = changes.querySelector<HTMLSelectElement>('select')!
    expect([...picker.options].map((option) => option.textContent)).toEqual(['src/pricing.ts', 'e2e/support/staging.ts · added'])
    await choose(changes, 'e2e/support/staging.ts')
    expect(changes.querySelector('[data-side="after"][data-source-line="1"]')?.textContent).toContain("BASE = 'http://127.0.0.1:4100'")
    expect(changes.querySelector('[data-side="before"][data-source-line]')).toBeNull()
  })

  it('marks a fix whose patch edits a test file, and leaves an app-only fix unmarked', async () => {
    const runsApi = await import('@/shared/api/runs')
    const [app, support] = cycleReviewFromPatch(`${patch('0.95', '0.9')}\n${supportPatch()}`)
    vi.mocked(runsApi.getRunCycleReview).mockResolvedValue({ iteration: 2, source: 'patch', patchPath: '/p', truncated: false, healMode: 'service', files: [app, support] })
    await mountStory({ journal: journalSections() })
    expect(section('section-notes')?.querySelector('[data-testid="fix-edits-spec"]')).toBeNull()
    vi.mocked(runsApi.getRunCycleReview).mockResolvedValue({ iteration: 2, source: 'patch', patchPath: '/p', truncated: false, healMode: 'service', files: [app, { ...support, path: 'e2e/pricing.spec.ts', role: 'spec' }] })
    const runId = vi.mocked(runsApi.getRunCycleReview).mock.calls[0][0]
    await act(async () => { invalidate('journal', runId); await new Promise((r) => setTimeout(r, 0)) })
    expect(section('section-notes')?.querySelector('[data-testid="fix-edits-spec"] [role="button"]')?.getAttribute('aria-label')).toBe('Edits a test file: e2e/pricing.spec.ts')
  })

  it('keeps the chosen file when the cycle is read again, and falls back to the first when it is gone', async () => {
    const runsApi = await import('@/shared/api/runs')
    const both = cycleReviewFromPatch(`${patch('0.95', '0.9')}\n${supportPatch()}`)
    vi.mocked(runsApi.getRunCycleReview).mockResolvedValue({ iteration: 2, source: 'patch', patchPath: '/p', truncated: false, healMode: 'service', files: both })
    await mountStory({ journal: journalSections() })
    const changes = section('section-changes')!
    await choose(changes, 'e2e/support/staging.ts')
    // What the journal's live topic does when the cycle's entry is rewritten.
    vi.mocked(runsApi.getRunCycleReview).mockResolvedValue({ iteration: 2, source: 'patch', patchPath: '/p', truncated: false, healMode: 'service', files: [both[1], both[0]] })
    const runId = vi.mocked(runsApi.getRunCycleReview).mock.calls[0][0]
    await act(async () => { invalidate('journal', runId); await new Promise((r) => setTimeout(r, 0)) })
    expect(changes.querySelector<HTMLSelectElement>('select')?.value).toBe('e2e/support/staging.ts')
    vi.mocked(runsApi.getRunCycleReview).mockResolvedValue({ iteration: 2, source: 'patch', patchPath: '/p', truncated: false, healMode: 'service', files: [both[0]] })
    await act(async () => { invalidate('journal', runId); await new Promise((r) => setTimeout(r, 0)) })
    expect(changes.querySelector('select')).toBeNull()
    expect(changes.querySelector('[data-side="after"][data-source-line="12"]')).not.toBeNull()
  })

  it('names a binary file or a bare rename instead of showing an empty table', async () => {
    const runsApi = await import('@/shared/api/runs')
    const files = cycleReviewFromPatch(['diff --git a/logo.png b/logo.png', 'Binary files a/logo.png and b/logo.png differ',
      'diff --git a/a.ts b/b.ts', 'similarity index 100%', 'rename from a.ts', 'rename to b.ts', ''].join('\n'))
    vi.mocked(runsApi.getRunCycleReview).mockResolvedValue({ iteration: 2, source: 'patch', patchPath: '/p', truncated: false, healMode: 'service', files })
    await mountStory({ journal: journalSections() })
    const changes = section('section-changes')!
    expect(changes.querySelector('[data-testid="cycle-file-without-rows"]')?.textContent).toBe('logo.png is a binary file; there is no text to compare.')
    await choose(changes, 'b.ts')
    expect(changes.querySelector('[data-testid="cycle-file-without-rows"]')?.textContent).toBe('b.ts was renamed from a.ts with no line edits.')
  })

  it('notes a renamed file and a missing final newline above its rows', async () => {
    const runsApi = await import('@/shared/api/runs')
    const files = cycleReviewFromPatch(['diff --git a/a.ts b/b.ts', 'rename from a.ts', 'rename to b.ts', '--- a/a.ts', '+++ b/b.ts',
      '@@ -1 +1 @@', '-x = 1', '+x = 2', '\\ No newline at end of file', ''].join('\n'))
    vi.mocked(runsApi.getRunCycleReview).mockResolvedValue({ iteration: 2, source: 'patch', patchPath: '/p', truncated: false, healMode: 'service', files })
    await mountStory({ journal: journalSections() })
    expect(section('section-changes')?.textContent).toContain('Renamed from a.ts. No newline at the end of the file after this repair.')
  })

  it('reads a cycle that changed no tracked files', async () => {
    const runsApi = await import('@/shared/api/runs')
    vi.mocked(runsApi.getRunCycleReview).mockResolvedValue({ iteration: 2, source: 'patch', patchPath: '/p', truncated: false, healMode: 'service', files: [] })
    await mountStory({ journal: journalSections() })
    expect(section('section-changes')?.textContent).toContain('This repair changed no tracked files.')
  })

  it('reports a patch it could not read', async () => {
    const runsApi = await import('@/shared/api/runs')
    vi.mocked(runsApi.getRunCycleReview).mockRejectedValue(new Error('EIO'))
    await mountStory({ journal: journalSections() })
    expect(section('section-changes')?.textContent).toContain('This repair\'s patch couldn\'t be read: EIO')
  })

  it('shows a cycle read from the journal\'s inline copy when no patch was kept', async () => {
    const runsApi = await import('@/shared/api/runs')
    vi.mocked(runsApi.getRunCycleReview).mockResolvedValue({ iteration: 1, source: 'journal', patchPath: null, truncated: true, healMode: 'service', files: cycleReviewFromPatch(patch('1', '0.95')) })
    await mountStory({ journal: journalSections(), attempt: 2 })
    const changes = section('section-changes')!
    expect(changes.querySelector('[data-side="after"][data-source-line="12"]')?.textContent).toContain('Math.round(p * 0.95)')
  })

  it('says a cycle recorded no diff when the server finds none', async () => {
    await mountStory({ journal: journalSections() })
    expect(section('section-changes')?.textContent).toContain('This repair recorded no diff.')
  })

  it('shows a recovered file whole, steps through its edits and offers English for a spec', async () => {
    const runsApi = await import('@/shared/api/runs')
    vi.mocked(runsApi.getRunCycleReview).mockResolvedValue({ iteration: 2, source: 'patch', patchPath: '/p', truncated: false, healMode: 'service', files: [recoveredFile()] })
    await mountStory({ journal: journalSections() })
    const changes = section('section-changes')!
    const lines = () => [...changes.querySelectorAll('[data-side="after"]')].map((line) => line.getAttribute('data-source-line'))
    expect(lines()).toEqual(['1', '2', '3', '4', '5'])
    expect(changes.querySelector('.cl-comparison-section')).toBeNull()
    expect(changes.querySelector('.cl-lang-switch')?.getAttribute('aria-disabled')).toBeNull()
    const selected = () => [...changes.querySelectorAll('[data-selected="true"] [data-side="after"]')].map((line) => line.getAttribute('data-source-line'))
    expect(changes.querySelector('[aria-label="Edit blocks in this file"]')?.textContent).toContain('Edit 1 / 2')
    expect(selected()).toEqual(['2'])
    act(() => { changes.querySelector<HTMLButtonElement>('[aria-label="Next change"]')!.click() })
    expect(changes.querySelector('[aria-label="Edit blocks in this file"]')?.textContent).toContain('Edit 2 / 2')
    expect(selected()).toEqual(['5'])
    // Switching to English re-centres on the same edit, which English folds differently.
    const scrolled = vi.spyOn(Element.prototype, 'scrollIntoView')
    try {
      act(() => { changes.querySelector<HTMLButtonElement>('[data-testid="test-presentation-english-tab"]')!.click() })
      expect(scrolled).toHaveBeenCalledWith({ block: 'center', behavior: 'instant' })
      expect(scrolled.mock.contexts.at(-1)).toBe(changes.querySelector('[data-selected="true"]'))
      // A row taller than the panel opens at its top.
      const tall = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(5000)
      const panel = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(400)
      act(() => { changes.querySelector<HTMLButtonElement>('[aria-label="Previous change"]')!.click() })
      tall.mockRestore()
      panel.mockRestore()
      expect(scrolled).toHaveBeenLastCalledWith({ block: 'start', behavior: 'instant' })
    } finally {
      scrolled.mockRestore()
    }
  })

  it('shows app code as code, and says when the run did not execute a suite edit', async () => {
    const runsApi = await import('@/shared/api/runs')
    const app = recoveredFile({ path: 'src/server.ts', role: 'app', blobs: { before: 'aaaaaaa', after: 'bbbbbbb' }, recovery: { kind: 'exact', from: 'after-blob', repo: '/repos/app' } })
    vi.mocked(runsApi.getRunCycleReview).mockResolvedValue({ iteration: 2, source: 'patch', patchPath: '/p', truncated: false, healMode: 'service', files: [app, recoveredFile({ executed: { kind: 'inert' } })] })
    await mountStory({ journal: journalSections() })
    const changes = section('section-changes')!
    expect(changes.querySelector('.cl-lang-switch')?.getAttribute('title')).toBe('App code is shown as code; English is for the suite\'s own files')
    expect(changes.querySelector('[data-testid="cycle-file-inert"]')).toBeNull()
    await choose(changes, 'e2e/cart.spec.ts')
    expect(changes.querySelector('[data-testid="cycle-file-inert"]')?.textContent).toContain('Not executed by this run')
  })

  it('adds no notice for a suite edit adopted into the run', async () => {
    const runsApi = await import('@/shared/api/runs')
    vi.mocked(runsApi.getRunCycleReview).mockResolvedValue({ iteration: 2, source: 'patch', patchPath: '/p', truncated: false, healMode: 'service', files: [recoveredFile({ executed: { kind: 'adopted', by: 'human', at: '2026-10-08T10:06:00.000Z' } })] })
    await mountStory({ journal: journalSections() })
    expect(section('section-changes')?.textContent).not.toContain('Adopted into')
  })

  it('says why a file is shown from its patch alone, and labels a new file\'s empty side', async () => {
    const runsApi = await import('@/shared/api/runs')
    const [patchOnly] = cycleReviewFromPatch(patch('0.95', '0.9')).map((file) => ({ ...file, recovery: { kind: 'patch-only' as const, reason: 'repo-missing' as const } }))
    const added = recoveredFile({ path: 'e2e/new.spec.ts', change: 'added', sources: { before: { source: '', tests: [] }, after: { source: 'x\n', tests: [] }, patch: 'diff --git a/old b/new\n--- a/old\n+++ b/new\n@@ -0,0 +1 @@\n+x' } })
    vi.mocked(runsApi.getRunCycleReview).mockResolvedValue({ iteration: 2, source: 'patch', patchPath: '/p', truncated: false, healMode: 'service', files: [patchOnly, added] })
    await mountStory({ journal: journalSections() })
    const changes = section('section-changes')!
    expect(changes.querySelector('.cl-lang-switch')?.getAttribute('title')).toBe('The repository that held this file is no longer on disk; showing the patch alone')
    await choose(changes, 'e2e/new.spec.ts')
    expect(changes.querySelector('.cl-comparison-empty')?.textContent).toBe('New file in this repair — nothing on the Before side')
  })
})

// ── helpers ──

const events: PlaywrightPlaybackEvent[] = [
  { type: 'test-begin', time: '2026-01-01T00:00:00.000Z', test: { name: 'checkout', title: 'passed checkout', location: 'checkout.spec.ts:1' } },
  { type: 'step-begin', time: '2026-01-01T00:00:01.000Z', test: { name: 'checkout', title: 'passed checkout' }, step: { title: 'Navigate to "/en_SG"', category: 'pw:api' } },
  { type: 'step-end', time: '2026-01-01T00:00:02.000Z', test: { name: 'checkout', title: 'passed checkout' }, step: { title: 'Navigate to "/en_SG"', category: 'pw:api' } },
  { type: 'step-begin', time: '2026-01-01T00:00:03.000Z', test: { name: 'checkout', title: 'passed checkout' }, step: { title: 'Click "Redeem"', category: 'pw:api' } },
  { type: 'step-end', time: '2026-01-01T00:00:04.000Z', test: { name: 'checkout', title: 'passed checkout' }, step: { title: 'Click "Redeem"', category: 'pw:api' } },
  { type: 'test-end', time: '2026-01-01T00:00:05.000Z', test: { name: 'checkout', title: 'passed checkout', location: 'checkout.spec.ts:1' }, status: 'passed', passed: true, durationMs: 40000, retry: 0 },
]

const manyActionEvents: PlaywrightPlaybackEvent[] = [
  events[0],
  ...['Navigate to "/en_SG"', 'Click "Redeem"', 'Fill "Email"', 'Fill "98981122" locator(\'#iframeFEOP iframe\').contentFrame().getByRole(\'textbox\', { name: \'Phone Number\' }).first()', 'Press "Enter"', 'Select "Singapore"', 'Check "Terms"', 'Expect "Success"', 'Click "Continue"', 'Expect "Order confirmed"']
    .map((title) => ({ type: 'step-begin' as const, time: '2026-01-01T00:00:01.000Z', test: { name: 'checkout', title: 'passed checkout' }, step: { title, category: 'pw:api' } })),
  events[5],
]

function failedWith(message: string, snippet?: string): PlaywrightPlaybackEvent[] {
  return events.map((e) => e.type === 'test-end' ? { ...e, status: 'failed', passed: false, error: { message, ...(snippet ? { snippet } : {}) } } : e)
}

function artifact(kind: PlaywrightArtifact['kind'], name: string): PlaywrightArtifact {
  return { name, kind, path: name, url: `/artifacts/${name}`, sizeBytes: 1, mtimeMs: 1 }
}

function patch(from: string, to: string): string {
  return ['--- a/src/pricing.ts', '+++ b/src/pricing.ts', '@@ -12 +12 @@', `-export const total = (p: number) => Math.round(p * ${from})`, `+export const total = (p: number) => Math.round(p * ${to})`].join('\n')
}

/** A spec whose two versions the server recovered: two separate edits. */
function recoveredFile(over: Partial<CycleReviewFile> = {}): CycleReviewFile {
  const [parsed] = cycleReviewFromPatch('diff --git a/e2e/cart.spec.ts b/e2e/cart.spec.ts\n--- a/e2e/cart.spec.ts\n+++ b/e2e/cart.spec.ts\n@@ -2 +2 @@\n-b\n+B')
  const full = ['diff --git a/old b/new', '--- a/old', '+++ b/new', '@@ -1,5 +1,5 @@', ' a', '-b', '+B', ' c', ' d', '-e', '+E'].join('\n')
  return { ...parsed, role: 'spec', recovery: { kind: 'reconstructed', verified: 'blob' },
    sources: { before: { source: 'a\nb\nc\nd\ne\n', tests: [] }, after: { source: 'a\nB\nc\nd\nE\n', tests: [] }, patch: full }, ...over }
}

function supportPatch(): string {
  return ['diff --git a/e2e/support/staging.ts b/e2e/support/staging.ts', 'new file mode 100644', '--- /dev/null', '+++ b/e2e/support/staging.ts',
    '@@ -0,0 +1 @@', "+export const BASE = 'http://127.0.0.1:4100'"].join('\n')
}

function journalSections(): JournalSection[] {
  const base = { feature: 'storefront', run: 'r', hypothesis: null }
  return [
    { ...base, iteration: 2, timestamp: '2026-10-08T10:08:30.000Z', outcome: 'all_tests_passed', cycle: 2, inputExecution: 2, failingTests: [evidenceCases.discount.name], body: '\n- hypothesis: the discount is 10 percent, not 5\n- fix.description: multiply by 0.9\n' },
    { ...base, iteration: 1, timestamp: '2026-10-08T10:04:30.000Z', outcome: 'partial', cycle: 1, inputExecution: 1, failingTests: [evidenceCases.discount.name, evidenceCases.inventory.name], body: `\n- hypothesis: rounding happens before tax\n\n### Diff\n\n\`\`\`diff\n${patch('1', '0.95')}\n\`\`\`\n` },
  ]
}

type DetailOver = Partial<Omit<RunDetail, 'manifest'>> & { manifest?: Partial<RunDetail['manifest']> }

function detailOf({ manifest, ...over }: DetailOver, runId = `run-${++runSeq}`): RunDetail {
  return {
    runId,
    manifest: {
      runId, executionType: 'run', feature: 'storefront', startedAt: '2026-01-01T00:00:00.000Z', endedAt: '2026-01-01T00:01:00.000Z',
      status: 'passed', healCycles: 0, services: [], ...manifest,
    },
    ...over,
  }
}

// What a workspace event does once it reaches the page: bump a live topic.
let invalidate: (topic: InvalidationTopic, scope?: string) => void = () => {}

type MountOpts = {
  view?: ResultsView
  selection?: ResultsSelection
  diagnostics?: VerificationDiagnostics
  onOpenArtifactSettings?: () => void
  unmatchedTest?: string
}

async function mount(detail: RunDetail, opts: MountOpts = {}) {
  const { rerender: _rerender, ...rest } = await mountLive(detail, opts)
  return rest
}

/** Mounts with a detail the test can push again, as the runs WebSocket does. */
async function mountLive(initial: RunDetail, opts: MountOpts = {}) {
  const selections: ResultsSelection[] = []
  const views: ResultsView[] = []
  let push: (detail: RunDetail) => void = () => {}
  function Harness() {
    const [detail, setDetail] = useState(initial)
    push = setDetail
    const [view, setView] = useState<ResultsView>(opts.view ?? 'tests')
    const [selection, setSelection] = useState<ResultsSelection>(opts.selection ?? { caseKey: null })
    return (
      <ResultsFixesTab
        detail={detail}
        view={view}
        onViewChange={(next) => { views.push(next); setView(next) }}
        selection={selection}
        onSelectionChange={(next) => { selections.push(next); setSelection(next) }}
        diagnostics={opts.diagnostics}
        onOpenArtifactSettings={opts.onOpenArtifactSettings}
        unmatchedTest={opts.unmatchedTest}
      />
    )
  }
  function Publisher() {
    invalidate = useInvalidation().invalidate
    return null
  }
  await act(async () => {
    root.render(<InvalidationProvider><Publisher /><Harness /></InvalidationProvider>)
    await Promise.resolve()
  })
  // Journal and patch reads resolve on later ticks.
  await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
  const rerender = async (detail: RunDetail) => {
    await act(async () => { push({ ...detail, runId: initial.runId, manifest: { ...detail.manifest, runId: initial.runId } }) })
  }
  return { selections, views, rerender }
}

/** A single-test run with its case open. A test that never failed opens on its
 *  artifacts; the rest open on the summary. */
async function renderSingle({ artifacts = [artifact('screenshot', 'canary-lab-final-page-checkout.png'), artifact('trace', 'trace.zip'), artifact('video', 'video.webm')], policy = { screenshot: 'on', trace: 'on', video: 'on' }, events: playbackEvents = events }: {
  artifacts?: PlaywrightArtifact[]
  policy?: PlaywrightArtifactPolicy
  events?: PlaywrightPlaybackEvent[]
} = {}) {
  const detail = detailOf({ playbackEvents, playwrightArtifacts: [{ testName: 'checkout', artifacts }], manifest: { playwrightArtifacts: policy } })
  const caseKey = buildRunEvidence({ events: playbackEvents }).cases[0]?.caseKey ?? null
  return mount(detail, { selection: { caseKey } })
}

function storyEvidence() {
  return buildRunEvidence({ events: stampedEvidencePlaybackEvents(), known: evidenceKnownTests, lifecycle: stampedEvidenceLifecycleEvents() })
}

function discountKey(): string {
  return storyEvidence().cases.find((c) => c.location === evidenceCases.discount.location)!.caseKey
}

// The approved sample run — discount fails in executions 1 and 2, passes in 3
// after repair cycle 2.
function storyDetail({ lifecycle = stampedEvidenceLifecycleEvents(), events: playbackEvents = stampedEvidencePlaybackEvents(), attemptArtifacts }: {
  lifecycle?: RunDetail['lifecycleEvents']
  events?: PlaywrightPlaybackEvent[]
  attemptArtifacts?: RunDetail['attemptArtifacts']
} = {}): RunDetail {
  return detailOf({
    playbackEvents, lifecycleEvents: lifecycle, ...(attemptArtifacts ? { attemptArtifacts } : {}),
    summary: { complete: true, total: 4, passed: 4, failed: [], knownTests: evidenceKnownTests },
    manifest: { healCycles: 2, playwrightArtifacts: { screenshot: 'on', trace: 'on', video: 'off' } },
  })
}

async function mountStory({ journal, selected = true, attempt, cycle, tab: testTab, ...story }: {
  journal?: JournalSection[]
  selected?: boolean
  attempt?: number
  cycle?: number
  tab?: 'summary' | 'artifacts'
  lifecycle?: RunDetail['lifecycleEvents']
  events?: PlaywrightPlaybackEvent[]
  attemptArtifacts?: RunDetail['attemptArtifacts']
} = {}) {
  const runsApi = await import('@/shared/api/runs')
  if (journal) vi.mocked(runsApi.listJournal).mockResolvedValue(journal)
  const selection: ResultsSelection = selected
    ? { caseKey: discountKey(), ...(attempt !== undefined ? { attempt } : {}), ...(cycle !== undefined ? { cycle } : {}), ...(testTab ? { tab: testTab } : {}) }
    : { caseKey: null }
  return mount(storyDetail(story), { selection })
}

// How the selection names the discount case for a link: its recorded name and spec location.
const discountTarget = { name: evidenceCases.discount.name, location: 'e2e/checkout.spec.ts:12' }

async function choose(changes: Element, path: string) {
  await act(async () => {
    const picker = changes.querySelector<HTMLSelectElement>('select')!
    picker.value = path
    picker.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

function caseRows(): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('[data-testid="case-result"]')]
}
function caseRow(): HTMLElement | undefined {
  return caseRows()[0]
}
function headerOf(caseKey: string): HTMLButtonElement | null | undefined {
  return caseRows().find((r) => r.dataset.caseKey === caseKey)?.querySelector<HTMLButtonElement>(':scope > button')
}
// The dialog is portalled out of the list's container.
function dialog(): HTMLElement | null {
  return document.body.querySelector('[data-testid="test-result-dialog"]')
}
function entryButtons(): HTMLButtonElement[] {
  return [...document.body.querySelectorAll<HTMLButtonElement>('[data-testid="timeline-entry"]')]
}
function timeline(): string[] {
  return entryButtons().map((b) => b.textContent ?? '')
}
function tab(label: string): HTMLButtonElement | undefined {
  return [...(dialog()?.querySelectorAll<HTMLButtonElement>('[role="tablist"] > [role="tab"]') ?? [])].find((b) => b.textContent === label)
}
function selectedTab(): string | undefined {
  return [...(dialog()?.querySelectorAll('[role="tablist"] > [role="tab"]') ?? [])].find((b) => b.getAttribute('aria-selected') === 'true')?.textContent ?? undefined
}
/** Each Summary card's title. */
function cards(): string[] {
  return [...document.body.querySelectorAll('[data-testid="test-summary"] section > header h3')].map((title) => title.textContent ?? '')
}
function evidencePanel(): HTMLElement | null {
  return document.body.querySelector('[data-testid="attempt-evidence"]')
}
function evidenceTab(id: 'steps' | 'screenshot' | 'video'): HTMLButtonElement | null {
  return document.body.querySelector(`[data-testid="evidence-tab-${id}"]`)
}
function section(testId: string): Element | null {
  return document.body.querySelector(`[data-testid="${testId}"]`)
}
function button(label: string): HTMLButtonElement | undefined {
  return [...document.body.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes(label))
}
