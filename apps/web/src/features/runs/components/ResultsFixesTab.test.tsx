import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { JournalSection, PlaywrightArtifact, PlaywrightPlaybackEvent, RunDetail, RunSummary } from '@shared/run-detail'
import type { PlaywrightArtifactPolicy } from '@shared/configs/playwright-modes'
import type { VerificationDiagnostics } from '@shared/verification'
import { buildRunEvidence } from '@shared/run-evidence'
import { evidenceCases, evidenceKnownTests, evidenceLifecycleEvents, evidencePlaybackEvents, stampedEvidenceLifecycleEvents, stampedEvidencePlaybackEvents } from '@shared/__fixtures__/run-evidence'
import { ApiError } from '@/shared/api/internal'
import type { ResultsSelection } from '../utils/results-fixes'
import { ResultsFixesTab, type ResultsView } from './ResultsFixesTab'

vi.mock(import('@/shared/api/runs'), async (importOriginal) => ({
  ...(await importOriginal()),
  listJournal: vi.fn(),
  getRunCyclePatch: vi.fn(),
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
  vi.mocked(runsApi.getRunCyclePatch).mockRejectedValue(new ApiError(404, null))
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

// ── Ported from the retired Playwright playback list: one case, recorded
//    before executions were stamped, so its media is the run's latest copy. ──

describe('a test’s result and evidence', () => {
  it('shortens Windows locations while retaining the full tooltip', async () => {
    const location = 'C:\\repo\\e2e\\checkout.spec.ts:12:3'
    await renderSingle({ events: [{ type: 'test-end', time: '2026-01-01T00:00:01.000Z', test: { name: 'checkout', title: 'checkout', location }, status: 'passed', passed: true, durationMs: 10, retry: 0 }] })
    const label = [...container.querySelectorAll('[title]')].find((node) => node.getAttribute('title') === location)
    expect(label?.textContent).toBe('e2e/checkout.spec.ts:12:3')
  })

  it('renders trace at the end of the evidence bar and keeps evidence collapsed', async () => {
    await renderSingle()

    expect(container.textContent).toContain('passed checkout')
    // The case header is identity and verdict only; the trace closes the
    // evidence bar along with screenshot, video, and steps.
    expect(caseRow()?.querySelector(':scope > button a[download="trace.zip"]')).toBeNull()
    const trace = container.querySelector('[data-testid="artifact-group"] a[download="trace.zip"]')
    expect(trace).toBeTruthy()
    expect(trace?.getAttribute('aria-label')).toBe('Download trace')
    expect(trace?.textContent).toBe('Trace')
    expect(trace?.querySelector('svg')).toBeTruthy()
    expect(trace?.className).toContain('truncate')
    expect(trace?.className).toContain('max-w-full')
    expect(container.textContent).toContain('Screenshot')
    expect(container.textContent).toContain('Video')
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).not.toContain('Open video')
    expect(container.querySelector('[data-testid="evidence-badge-steps"]')?.textContent).toBe('2')
    expect(container.textContent).not.toContain('Opened /en_SG')
    expect(container.textContent).not.toContain('Clicked Redeem')
  })

  it('keeps at most one evidence panel open, so the card cannot stack three', async () => {
    await renderSingle()
    act(() => { button('Screenshot')?.click() })
    expect(container.querySelector('img')).toBeTruthy()
    act(() => { button('Steps')?.click() })
    expect(container.textContent).toContain('Opened /en_SG')
    expect(container.querySelector('img')).toBeNull()
  })

  it('lays a matcher failure out as its headline over an expected/received table', async () => {
    await renderSingle({ events: failedWith('Error: expect(received).toBe(expected) // Object.is equality\n\nExpected: "ready"\nReceived: "broken"') })
    const block = container.querySelector('[data-testid="assertion-message"]')
    expect(block?.firstElementChild?.textContent).toBe('Error: expect(received).toBe(expected) // Object.is equality')
    expect([...(block?.querySelectorAll('dt') ?? [])].map((n) => n.textContent)).toEqual(['Expected', 'Received'])
    expect([...(block?.querySelectorAll('dd') ?? [])].map((n) => n.textContent)).toEqual(['"ready"', '"broken"'])
    expect(container.textContent).toContain('failed')
  })

  it('keeps a message it cannot split verbatim', async () => {
    await renderSingle({ events: failedWith('TypeError: boom') })
    expect(container.querySelector('[data-testid="assertion-message"]')).toBeNull()
    expect(container.querySelector('[data-testid="section-failure"] pre')?.textContent).toBe('TypeError: boom')
  })

  it('shows the failure’s code frame when the runner recorded one', async () => {
    await renderSingle({ events: failedWith('TypeError: boom', '> 12 |   await expect(total).toBe(90)') })
    expect(container.querySelector('[data-testid="section-failure"] pre')?.textContent).toBe('> 12 |   await expect(total).toBe(90)')
  })

  it('says nothing at all on a clean pass instead of narrating the absence of an error', async () => {
    await renderSingle()
    expect(container.querySelector('[data-testid="section-failure"]')?.textContent).not.toMatch(/error|Status:/i)
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
    const rows = caseRows()
    expect(rows.map((r) => r.querySelector(':scope > button')?.textContent)).toEqual(['#1firsta.spec.ts:5not run', '#2secondb.spec.ts:5passed'])
  })

  it('expands retained screenshots only when requested', async () => {
    await renderSingle()
    act(() => { button('Screenshot')?.click() })
    expect(container.querySelector('img')?.getAttribute('alt')).toBe('Final page screenshot')
  })

  it('opens retained video inline from an explicit action', async () => {
    await renderSingle()
    act(() => { button('Video')?.click() })
    const open = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Open video')
    expect(open).toBeTruthy()
    act(() => { open?.click() })
    expect(container.querySelector('video')?.getAttribute('src')).toBe('/artifacts/video.webm')
    expect(open?.textContent).toBe('Hide video')
  })

  it('expands the step trace only when requested', async () => {
    await renderSingle()
    act(() => { button('Steps')?.click() })
    expect(container.textContent).toContain('Opened /en_SG')
    expect(container.textContent).toContain('Clicked Redeem')
  })

  it('keeps steps after the eighth in the collapsed trace count and expanded list', async () => {
    await renderSingle({ events: manyActionEvents })
    expect(container.querySelector('[data-testid="evidence-badge-steps"]')?.textContent).toBe('10')
    expect(container.textContent).not.toContain('Clicked Continue')
    act(() => { button('Steps')?.click() })
    expect(container.textContent).toContain('Clicked Continue')
    expect(container.textContent).toContain('Verified Order confirmed')
  })

  it('keeps artifact actions visible when no screenshot is retained', async () => {
    await renderSingle({ artifacts: [artifact('trace', 'trace.zip'), artifact('video', 'video.webm')] })
    expect(container.querySelector('[data-testid="evidence-badge-screenshot"]')?.textContent).toBe('None')
    expect(container.querySelector('[data-testid="evidence-tab-screenshot"]')?.getAttribute('title')).toBe('No screenshot retained')
    expect(container.querySelector('a[download="trace.zip"]')).toBeTruthy()
    expect(container.textContent).not.toContain('Open video')
  })

  it('renders skipped status as warning, not danger', async () => {
    await renderSingle({ events: events.map((e) => e.type === 'test-end' ? { ...e, status: 'skipped', passed: false } : e) })
    const pills = [...container.querySelectorAll('span')].filter((s) => s.textContent === 'skipped')
    expect(pills.length).toBeGreaterThan(0)
    for (const pill of pills) {
      expect(pill.className).toContain('warning')
      expect(pill.className).not.toContain('danger')
    }
  })

  it('uses short artifact guidance and keeps the settings control on the pane rail, not the card', async () => {
    await renderSingle({ artifacts: [artifact('screenshot', 'canary-lab-final-page-checkout.png'), artifact('trace', 'trace.zip')], policy: { screenshot: 'on', trace: 'on', video: 'off' } })
    expect(container.querySelector('[data-testid="evidence-badge-video"]')?.textContent).toBe('Disabled')
    expect(container.textContent).not.toContain('Feature Configuration > Playwright > Browser & Artifacts > Video')
    expect(container.querySelector('a[download="trace.zip"]')).toBeTruthy()
    // One per-suite control on the pane rail — never repeated on a card.
    expect([...container.querySelectorAll('[data-testid="results-tests"] button')].filter((b) => b.textContent?.includes('Settings'))).toHaveLength(0)
    const onSettings = vi.fn()
    await mount(detailOf({ playbackEvents: events }), { onOpenArtifactSettings: onSettings })
    const settings = [...container.querySelectorAll('button')].filter((b) => b.textContent?.includes('Artifact settings'))
    expect(settings).toHaveLength(1)
    act(() => settings[0].click())
    expect(onSettings).toHaveBeenCalledOnce()
  })

  it('shows the attempt still running instead of the earlier failure', async () => {
    await renderSingle({
      events: [
        { type: 'test-begin', time: '2026-01-01T00:00:00.000Z', test: { name: 'checkout', title: 'checkout failed before heal', location: 'checkout.spec.ts:1' } },
        { type: 'test-end', time: '2026-01-01T00:01:00.000Z', test: { name: 'checkout', title: 'checkout failed before heal', location: 'checkout.spec.ts:1' }, status: 'failed', passed: false, durationMs: 60000, retry: 0, error: { message: 'old failure' } },
        { type: 'test-begin', time: '2026-01-01T00:10:00.000Z', test: { name: 'checkout', title: 'checkout rerun now', location: 'checkout.spec.ts:1' } },
      ],
    })
    expect(container.textContent).not.toContain('checkout failed before heal')
    expect(container.textContent).not.toContain('old failure')
    expect(container.textContent).toContain('checkout rerun now')
    expect(container.textContent).toContain('Currently executing in this Playwright process.')
    expect([...container.querySelectorAll('span')].some((s) => s.textContent === 'running')).toBe(true)
    expect(caseRows()).toHaveLength(1)
    expect(caseRow()?.getAttribute('style') ?? '').not.toMatch(/background|box-shadow/)
  })
})

// ── The repair story: the approved sample run — discount fails in executions
//    1 and 2, passes in 3 after repair cycle 2. ──

describe('a repaired test’s story', () => {
  it('opens on the latest cycle with the six sections in the approved order', async () => {
    await mountStory()
    const select = cycleSelect()
    expect(select?.value).toBe('2')
    expect([...select!.options].map((o) => o.textContent)).toEqual(['Repair cycle 2 — Passed (latest)', 'Repair cycle 1 — Failed', 'Initial execution — Failed'])
    expect(sectionTitles()).toEqual(['Failure addressed', 'Repair notes', 'Code changes', 'Runner verification', 'Artifacts'])
    expect(section('section-failure')?.textContent).toContain('Execution 2')
    expect(section('section-failure')?.textContent).toContain('Expected total 90, received 95')
    expect(section('section-verification')?.textContent).toContain('Passed in execution 3 — the assertion held after this repair.')
    expect(groupLabels()).toEqual(['Before this repair', 'After this repair'])
  })

  it('moves every section to an earlier cycle together', async () => {
    const { selections } = await mountStory()
    await act(async () => {
      cycleSelect()!.value = '1'
      cycleSelect()!.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(selections.at(-1)).toEqual({ caseKey: discountKey(), cycle: 1 })
    expect(section('section-failure')?.textContent).toContain('Execution 1')
    expect(section('section-failure')?.textContent).toContain('Expected total 90, received 100')
    expect(section('section-verification')?.textContent).toContain('Failed in execution 2')
    expect(section('section-changes')?.textContent).toContain('Repair cycle 1')
  })

  it('shows the initial execution as a plain test result with no repair sections', async () => {
    await mountStory({ cycle: 'initial' })
    expect(sectionTitles()).toEqual(['Test result', 'Artifacts'])
    expect(groupLabels()).toEqual(['Initial execution'])
  })

  it('draws no after-repair evidence while verification is pending', async () => {
    await mountStory({ lifecycle: stampedEvidenceLifecycleEvents().slice(0, 6), events: stampedEvidencePlaybackEvents().filter((e) => e.time < '2026-10-08T10:09:00.000Z') })
    expect(cycleSelect()?.options[0].textContent).toBe('Repair cycle 2 — Verification pending (latest)')
    expect(section('section-verification')?.textContent).toContain('No execution has run since this repair. The latest recorded result is still failed from execution 2.')
    expect(groupLabels()).toEqual(['Before this repair'])
  })

  it('says why a stamped attempt has no media instead of borrowing a name match', async () => {
    await mountStory()
    expect(container.querySelectorAll('[data-testid="artifact-group"]')[0]?.textContent).toContain('No screenshot, video or trace was retained for this execution.')
  })

  it('shows the attempt’s own retained media', async () => {
    const evidence = buildRunEvidence({ events: stampedEvidencePlaybackEvents(), known: evidenceKnownTests, lifecycle: stampedEvidenceLifecycleEvents() })
    const input = evidence.cases.find((c) => c.caseKey === discountKey())!.cycles[1].input
    await mountStory({ attemptArtifacts: { [input.attemptKey]: [artifact('screenshot', 'discount-exec-2.png')] } })
    act(() => { button('Screenshot')?.click() })
    expect(container.querySelector('img')?.getAttribute('src')).toBe('/artifacts/discount-exec-2.png')
  })
})

describe('artifacts by execution', () => {
  const legacyDetail = (over: DetailOver = {}) => detailOf({
    playbackEvents: evidencePlaybackEvents, lifecycleEvents: evidenceLifecycleEvents,
    summary: { complete: true, total: 4, passed: 4, failed: [], knownTests: evidenceKnownTests },
    playwrightArtifacts: [
      { testName: evidenceCases.discount.name, artifacts: [artifact('screenshot', 'discount-latest.png')] },
      { testName: evidenceCases.homeLoads.name, artifacts: [artifact('screenshot', 'loads-latest.png')] },
    ],
    manifest: { healCycles: 2, playwrightArtifacts: { screenshot: 'on', trace: 'on', video: 'off' } },
    ...over,
  })
  const legacyKey = (location: string) => buildRunEvidence({ events: evidencePlaybackEvents, known: evidenceKnownTests, lifecycle: evidenceLifecycleEvents })
    .cases.find((c) => c.location === location)!.caseKey

  it('closes opened media when the cycle changes, so no screenshot sits under another cycle’s label', async () => {
    const evidence = buildRunEvidence({ events: stampedEvidencePlaybackEvents(), known: evidenceKnownTests, lifecycle: stampedEvidenceLifecycleEvents() })
    const discount = evidence.cases.find((c) => c.caseKey === discountKey())!
    await mountStory({ attemptArtifacts: {
      [discount.cycles[1].input.attemptKey]: [artifact('screenshot', 'exec-2.png')],
      [discount.cycles[0].input.attemptKey]: [artifact('screenshot', 'exec-1.png')],
    } })
    act(() => { button('Screenshot')?.click() })
    expect(container.querySelector('img')?.getAttribute('src')).toBe('/artifacts/exec-2.png')
    await act(async () => {
      cycleSelect()!.value = '1'
      cycleSelect()!.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(container.querySelector('img')).toBeNull()
    act(() => { button('Screenshot')?.click() })
    expect(container.querySelector('img')?.getAttribute('src')).toBe('/artifacts/exec-1.png')
  })

  it('closes opened media when another test is opened', async () => {
    const evidence = buildRunEvidence({ events: stampedEvidencePlaybackEvents(), known: evidenceKnownTests, lifecycle: stampedEvidenceLifecycleEvents() })
    const input = evidence.cases.find((c) => c.caseKey === discountKey())!.cycles[1].input
    await mountStory({ attemptArtifacts: { [input.attemptKey]: [artifact('screenshot', 'exec-2.png')] } })
    act(() => { button('Screenshot')?.click() })
    expect(container.querySelector('img')).toBeTruthy()
    const inventory = caseRows().find((r) => r.textContent?.includes('inventory.spec.ts'))!
    act(() => inventory.querySelector<HTMLButtonElement>(':scope > button')!.click())
    act(() => headerOf(discountKey())!.click())
    expect(container.querySelector('img')).toBeNull()
  })

  it('says media is still being saved for an execution that has not finished', async () => {
    await mountStory({ lifecycle: stampedEvidenceLifecycleEvents().slice(0, 7) })
    const groups = container.querySelectorAll('[data-testid="artifact-group"]')
    expect(groups[1]?.querySelector('h4')?.textContent).toBe('After this repair')
    expect(groups[1]?.textContent).toContain('Media is saved when this execution finishes.')
  })

  it('shows a legacy run’s one kept copy on the latest attempt only, and says why earlier ones have none', async () => {
    await mount(legacyDetail(), { selection: { caseKey: legacyKey(evidenceCases.discount.location) } })
    const groups = () => [...container.querySelectorAll('[data-testid="artifact-group"]')]
    expect(groups()[0]?.textContent).toContain('Not retained: this run kept one copy per test, and a later attempt replaced it.')
    expect(groups()[1]?.textContent).toContain('The run\'s one retained copy for this test — it belongs to this latest attempt.')
    act(() => { [...groups()[1].querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('Screenshot'))!.click() })
    expect(container.querySelector('img')?.getAttribute('src')).toBe('/artifacts/discount-latest.png')
  })

  it('refuses a kept copy two same-name tests could own', async () => {
    await mount(legacyDetail(), { selection: { caseKey: legacyKey(evidenceCases.homeLoads.location) } })
    const group = container.querySelector('[data-testid="artifact-group"]')
    expect(group?.querySelector('h4')?.textContent).toBe('Test result')
    expect(group?.textContent).toContain('Not shown: another test with the same name could own the retained copy.')
    expect(group?.querySelector('[data-testid="evidence-badge-screenshot"]')?.textContent).toBe('None')
  })
})

describe('repair notes and code changes', () => {
  it('reads the cycle’s own journal entry and opens it and the whole journal in full', async () => {
    await mountStory({ journal: journalSections() })
    expect(section('section-notes')?.querySelector('h3 + span')?.textContent).toBe('Journal · cycle entry')
    expect(section('section-notes')?.textContent).toContain('the discount is 10 percent, not 5')
    act(() => { button('Read full entry')?.click() })
    expect(document.querySelector('[data-testid="journal-source-modal"]')?.textContent).toBe(`Iteration 2${journalSections()[0].body}`)
    act(() => { button('Full run journal')?.click() })
    const full = document.querySelector('[data-testid="journal-source-modal"]')?.textContent ?? ''
    expect(full.startsWith('Full run journal## Iteration 1')).toBe(true)
    expect(full).toContain('## Iteration 2')
  })

  it('labels a cycle entry that covered several tests as run-wide', async () => {
    await mountStory({ journal: journalSections(), cycle: 1 })
    expect(section('section-notes')?.querySelector('h3 + span')?.textContent).toBe('Journal · run-wide cycle entry')
    expect(section('section-notes')?.textContent).toContain('This cycle entry covers 2 tests.')
  })

  it('renders the cycle’s retained patch with the shared diff view', async () => {
    const runsApi = await import('@/shared/api/runs')
    vi.mocked(runsApi.getRunCyclePatch).mockResolvedValue({ iteration: 2, patchPath: '/runs/r/diffs/iteration-2.patch', diff: patch('0.95', '0.9') })
    await mountStory({ journal: journalSections() })
    expect(runsApi.getRunCyclePatch).toHaveBeenCalledWith(expect.any(String), 2)
    expect(section('section-changes')?.textContent).toContain('Math.round(p * 0.9)')
    expect(section('section-changes')?.textContent).toContain("This cycle's edits · /runs/r/diffs/iteration-2.patch")
  })

  it('falls back to the entry’s inline diff when no patch file was retained, and says it is run-wide', async () => {
    await mountStory({ journal: journalSections(), cycle: 1 })
    expect(section('section-changes')?.textContent).toContain('Math.round(p * 0.95)')
    expect(section('section-changes')?.textContent).toContain("From the journal entry's inline diff · run-wide: the edit is not attributed to one test")
  })

  it('names a cycle with no journal entry instead of inventing notes or a patch', async () => {
    await mountStory({ journal: [] })
    expect(section('section-notes')?.textContent).toContain('No journal entry is attributed to repair cycle 2 yet.')
    expect(section('section-changes')?.textContent).toContain('No patch is attributed to repair cycle 2.')
  })

  it('opens the run-wide captures from a cycle’s code changes', async () => {
    const { views } = await mountStory({ journal: [] })
    act(() => { button('Run-wide changes')?.click() })
    expect(views.at(-1)).toBe('run-wide')
    expect(container.querySelector('[data-testid="results-run-wide"]')).toBeTruthy()
  })
})

describe('the run’s own evidence', () => {
  it('keeps the captured changes, every journal entry and unclaimed files reachable with no test open', async () => {
    const runsApi = await import('@/shared/api/runs')
    vi.mocked(runsApi.listJournal).mockResolvedValue(journalSections())
    const unassigned = { ...artifact('screenshot', 'orphan.png'), execution: 2 }
    await mount(detailOf({
      playbackEvents: stampedEvidencePlaybackEvents(), lifecycleEvents: stampedEvidenceLifecycleEvents(),
      summary: { complete: true, total: 4, passed: 4, failed: [], knownTests: evidenceKnownTests }, unassignedArtifacts: [unassigned],
      manifest: { healCycles: 2 },
    }), { view: 'run-wide' })
    const view = container.querySelector('[data-testid="results-run-wide"]')
    expect(view?.querySelector('[data-testid="changes-empty"]')).toBeTruthy()
    expect(view?.textContent).toContain('Iteration 1')
    expect(view?.textContent).toContain('Iteration 2')
    expect(view?.querySelector('[data-testid="unassigned-artifacts"] a')?.getAttribute('href')).toBe('/artifacts/orphan.png')
    expect(view?.querySelector('[data-testid="unassigned-artifacts"]')?.textContent).toContain('execution 2 · screenshot')
  })

  it('lists results recorded outside every known execution', async () => {
    await mount(detailOf({ playbackEvents: events, lifecycleEvents: [{ phase: 'running-tests', headline: 'x', updatedAt: '2026-01-02T00:00:00.000Z' }] }), { view: 'run-wide' })
    expect(container.querySelector('[data-testid="unplaced-attempts"]')?.textContent).toContain('passed checkout')
  })

  it('keeps the Playwright terminal as its own view', async () => {
    await mount(detailOf({ playbackEvents: events }), { view: 'terminal' })
    expect(paneTerminals.props.map((p) => p.paneId)).toEqual(['playwright'])
  })

  it('offers a verify run its diagnostics and results, but no run-wide repair evidence', async () => {
    const diagnostics: VerificationDiagnostics = { generatedAt: '2026-01-01T00:00:00.000Z', summary: 'Remote target returned 500.', targetUrls: {}, failedTests: [] }
    await mount(detailOf({ playbackEvents: events }), { repairEvidence: false, diagnostics })
    expect([...container.querySelectorAll('[role="tab"], button')].map((b) => b.textContent)).not.toContain('Run-wide')
    expect(container.textContent).toContain('Remote target returned 500. Verify does not edit code or start a heal cycle.')
  })

  it('says so when the run recorded no test at all', async () => {
    await mount(detailOf({}))
    expect(container.textContent).toContain('No playback events captured')
  })
})

describe('accordion selection', () => {
  it('opens one case at a time, collapses the open one, and follows its latest cycle', async () => {
    const { selections } = await mountStory({ selected: false })
    expect(caseRows().some((r) => r.hasAttribute('data-open'))).toBe(false)
    act(() => headerOf(discountKey())?.click())
    expect(selections.at(-1)).toEqual({ caseKey: discountKey() })
    expect(caseRows().filter((r) => r.hasAttribute('data-open'))).toHaveLength(1)
    expect(headerOf(discountKey())?.getAttribute('aria-expanded')).toBe('true')
    act(() => headerOf(discountKey())?.click())
    expect(selections.at(-1)).toEqual({ caseKey: null })
  })

  it('tells a case no repair addressed apart from one that never ran', async () => {
    await mountStory({ selected: false })
    const home = caseRows().find((r) => r.textContent?.includes('home.spec.ts'))!
    act(() => home.querySelector<HTMLButtonElement>(':scope > button')!.click())
    expect(home.textContent).toContain('No repair cycle addressed this test.')
    expect(home.querySelector('select')).toBeNull()
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
  return ['--- a/src/pricing.ts', '+++ b/src/pricing.ts', '@@ -1 +1 @@', `-export const total = (p: number) => Math.round(p * ${from})`, `+export const total = (p: number) => Math.round(p * ${to})`].join('\n')
}

function journalSections(): JournalSection[] {
  const base = { feature: 'storefront', run: 'r', hypothesis: null }
  return [
    { ...base, iteration: 2, timestamp: '2026-10-08T10:08:30.000Z', outcome: 'all_tests_passed', cycle: 2, inputExecution: 2, failingTests: [evidenceCases.discount.name], body: '\n- hypothesis: the discount is 10 percent, not 5\n- fix.description: multiply by 0.9\n' },
    { ...base, iteration: 1, timestamp: '2026-10-08T10:04:30.000Z', outcome: 'partial', cycle: 1, inputExecution: 1, failingTests: [evidenceCases.discount.name, evidenceCases.inventory.name], body: `\n- hypothesis: rounding happens before tax\n\n### Diff\n\n\`\`\`diff\n${patch('1', '0.95')}\n\`\`\`\n` },
  ]
}

type DetailOver = Partial<Omit<RunDetail, 'manifest'>> & { manifest?: Partial<RunDetail['manifest']> }

function detailOf({ manifest, ...over }: DetailOver): RunDetail {
  const runId = `run-${++runSeq}`
  return {
    runId,
    manifest: {
      runId, executionType: 'run', feature: 'storefront', startedAt: '2026-01-01T00:00:00.000Z', endedAt: '2026-01-01T00:01:00.000Z',
      status: 'passed', healCycles: 0, services: [], ...manifest,
    },
    ...over,
  }
}

async function mount(detail: RunDetail, opts: {
  view?: ResultsView
  selection?: ResultsSelection
  repairEvidence?: boolean
  diagnostics?: VerificationDiagnostics
  onOpenArtifactSettings?: () => void
} = {}) {
  const selections: ResultsSelection[] = []
  const views: ResultsView[] = []
  function Harness() {
    const [view, setView] = useState<ResultsView>(opts.view ?? 'tests')
    const [selection, setSelection] = useState<ResultsSelection>(opts.selection ?? { caseKey: null })
    return (
      <ResultsFixesTab
        detail={detail}
        view={view}
        onViewChange={(next) => { views.push(next); setView(next) }}
        selection={selection}
        onSelectionChange={(next) => { selections.push(next); setSelection(next) }}
        repairEvidence={opts.repairEvidence ?? true}
        diagnostics={opts.diagnostics}
        onOpenArtifactSettings={opts.onOpenArtifactSettings}
      />
    )
  }
  await act(async () => {
    root.render(<Harness />)
    await Promise.resolve()
  })
  // Journal and patch reads resolve on later ticks.
  await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
  return { selections, views }
}

async function renderSingle({ artifacts = [artifact('screenshot', 'canary-lab-final-page-checkout.png'), artifact('trace', 'trace.zip'), artifact('video', 'video.webm')], policy = { screenshot: 'on', trace: 'on', video: 'on' }, events: playbackEvents = events }: {
  artifacts?: PlaywrightArtifact[]
  policy?: PlaywrightArtifactPolicy
  events?: PlaywrightPlaybackEvent[]
} = {}) {
  const detail = detailOf({ playbackEvents, playwrightArtifacts: [{ testName: 'checkout', artifacts }], manifest: { playwrightArtifacts: policy } })
  const caseKey = buildRunEvidence({ events: playbackEvents }).cases[0]?.caseKey ?? null
  return mount(detail, { selection: { caseKey } })
}

function discountKey(): string {
  return buildRunEvidence({ events: stampedEvidencePlaybackEvents(), known: evidenceKnownTests, lifecycle: stampedEvidenceLifecycleEvents() })
    .cases.find((c) => c.location === evidenceCases.discount.location)!.caseKey
}

async function mountStory({ journal, cycle, selected = true, lifecycle = stampedEvidenceLifecycleEvents(), events: playbackEvents = stampedEvidencePlaybackEvents(), attemptArtifacts }: {
  journal?: JournalSection[]
  cycle?: number | 'initial'
  selected?: boolean
  lifecycle?: RunDetail['lifecycleEvents']
  events?: PlaywrightPlaybackEvent[]
  attemptArtifacts?: RunDetail['attemptArtifacts']
} = {}) {
  const runsApi = await import('@/shared/api/runs')
  if (journal) vi.mocked(runsApi.listJournal).mockResolvedValue(journal)
  return mount(detailOf({
    playbackEvents, lifecycleEvents: lifecycle, ...(attemptArtifacts ? { attemptArtifacts } : {}),
    summary: { complete: true, total: 4, passed: 4, failed: [], knownTests: evidenceKnownTests },
    manifest: { healCycles: 2, playwrightArtifacts: { screenshot: 'on', trace: 'on', video: 'off' } },
  }), { selection: selected ? { caseKey: discountKey(), ...(cycle !== undefined ? { cycle } : {}) } : { caseKey: null } })
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
function cycleSelect(): HTMLSelectElement | null {
  return container.querySelector('[data-open] select')
}
function section(testId: string): Element | null {
  return container.querySelector(`[data-testid="${testId}"]`)
}
function sectionTitles(): string[] {
  return [...container.querySelectorAll('[data-testid="repair-story"] > section h3')].map((h) => h.textContent ?? '')
}
function groupLabels(): string[] {
  return [...container.querySelectorAll('[data-testid="artifact-group"] h4')].map((h) => h.textContent ?? '')
}
function button(label: string): HTMLButtonElement | undefined {
  return [...document.body.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes(label))
}
