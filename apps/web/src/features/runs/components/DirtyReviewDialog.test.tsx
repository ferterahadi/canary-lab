// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Feature, RunIndexEntry, RunDetail } from '@/shared/api/types'
import * as api from '@/shared/api/client'
import { testFileReview } from '@/shared/api/__fixtures__/test-review'
import { DirtyReviewDialog } from './DirtyReviewDialog'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
vi.mock('@/shared/api/client', async (original) => ({ ...await original<typeof api>(),
  getTestFileReview: vi.fn(), commitDirtySpecs: vi.fn(), adoptSpecEdits: vi.fn(), restoreSpecEdits: vi.fn(), openEditor: vi.fn(), openWorkspace: vi.fn(),
}))
vi.mock('../state/RunsContext', () => ({ useRun: () => ({ detail: undefined, error: null }) }))
let root: Root
let container: HTMLDivElement
const feature = (name = 'alpha', files = ['e2e/a.spec.ts']): Feature => ({ name, description: '', envs: [], repos: [], dirty: { status: 'dirty', specs: files.map((file) => ({ file, affectedTests: ['a'] })) } })
const run = { runId: 'run-1', feature: 'alpha', status: 'healing', pendingSpecEdits: 1 } as RunIndexEntry
const detail = { manifest: { runId: 'run-1', feature: 'alpha', specEdits: { pending: [{ file: 'e2e/a.spec.ts', affectedTests: ['a'] }] } } } as RunDetail
beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(api.getTestFileReview).mockResolvedValue(testFileReview())
  vi.mocked(api.commitDirtySpecs).mockResolvedValue({ committed: true })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(() => { act(() => root.unmount()); container.remove() })
const buttons = () => [...document.querySelectorAll<HTMLButtonElement>('button')]
const button = (label: string) => buttons().find((item) => item.getAttribute('aria-label') === label || item.textContent?.trim() === label)!
async function render(props: Partial<Parameters<typeof DirtyReviewDialog>[0]> = {}) {
  await act(async () => root.render(<DirtyReviewDialog features={[feature()]} onClose={vi.fn()} {...props} />))
}
const click = async (label: string) => act(async () => button(label).click())
it('lists a pending robustness envelope edit by name, not as zero tests', async () => {
  // D15: the envelope rides in the run-start copy, so a mid-run edit to it is
  // pending like a spec edit — but it declares exposure, not tests.
  const pending = { manifest: { runId: 'run-1', feature: 'alpha', specEdits: { pending: [
    { file: 'e2e/a.spec.ts', affectedTests: ['a'] },
    { file: 'robustness/envelope.json', affectedTests: [] },
  ] } } } as RunDetail
  await render({ features: [], pendingRuns: [run], focusFeature: 'alpha', focusRunId: 'run-1', focusRunDetail: pending })
  const rows = [...document.querySelectorAll('.cl-review-file')].map((item) => item.textContent)
  expect(rows.some((text) => text?.includes('a.spec.ts') && text.includes('1 test'))).toBe(true)
  expect(rows.some((text) => text?.includes('robustness/envelope.json') && text.includes('perturbation envelope'))).toBe(true)
  expect(document.body.textContent).not.toContain('0 tests')
})

it('shows a whole test with equal before/after columns, unchanged context and exact source edits', async () => {
  await render()
  await click('Code')
  expect([...document.querySelectorAll('thead th')].map((item) => item.textContent)).toEqual(['Before · Git HEAD', 'After · Working copy'])
  expect(document.querySelector('tbody')?.textContent).toContain('const context = x')
  expect(document.querySelector('del')?.textContent).toBe('  expect(x).toBe(1)')
  expect(document.querySelector('ins')?.textContent).toBe('  expect(x).toBe(2)')
  expect(document.body.textContent).toContain('Change 1 of 2')
  expect(document.body.textContent).toContain('Different expected values are not ordered by strength')
  expect(document.querySelector('tbody')?.textContent).toContain('import { test')
  expect(document.querySelector('[aria-label="Test context"]')).toBeNull()
  expect(document.querySelector('.cl-comparison-legend')).toBeNull()
  expect(document.querySelector('[aria-label="Open workspace in editor"]')).toBeNull()
  expect(button('Code').className).toBe('cl-lang-switch-btn')
})
it('keeps the selected change when switching English and Code and exposes full-file setup', async () => {
  await render()
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Next change"]')!.click())
  await click('Code'); await click('English')
  expect(document.body.textContent).toContain('Change 2 of 2')
  expect(document.querySelector('tbody')?.textContent).toContain('import { test')
})
it.each(['before', 'after'] as const)('opens the exact %s source range when an English sentence is clicked', async (side) => {
  const review = testFileReview()
  // The selected sentence is outside the active change and covers two lines.
  // The click must follow its own source range, not jump to the diff cursor.
  review[side].story = { steps: [{ id: 'setup', role: 'setup', text: 'Set up x and check it', spans: [{ text: 'Set up x and check it' }], fidelity: 'derived',
    source: { file: review.file, startLine: 6, endLine: 7, snippet: review[side].source.split('\n').slice(5, 7).join('\n') } }] }
  vi.mocked(api.getTestFileReview).mockResolvedValue(review)
  const onFocus = vi.fn()
  const scrolled: Element[] = []
  const scrollIntoView = vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(function (this: HTMLElement) { scrolled.push(this) })
  try {
    await render({ onFocus })
    const target = document.querySelector<HTMLButtonElement>(`[data-side="${side}"][data-source-line="6"] button`)!
    expect(target.title).toContain('code at line 6')
    const pane = document.querySelector<HTMLElement>('.cl-comparison-wrap')!
    pane.scrollTop = 317; pane.scrollLeft = 24
    await act(async () => target.click())
    expect(button('Code').getAttribute('aria-selected')).toBe('true')
    expect(onFocus).toHaveBeenLastCalledWith({ file: review.file, line: 6, mode: 'code' })
    await render({ onFocus, focus: { file: review.file, line: 6, mode: 'code' } })
    expect(document.body.textContent).toContain('Change 1 of 2')
    expect([...document.querySelectorAll('[data-source-selected]')].map((element) => [element.getAttribute('data-side'), element.getAttribute('data-source-line')])).toEqual([[side, '6'], [side, '7']])
    expect(document.activeElement?.getAttribute('data-source-line')).toBe('6')
    expect(scrolled.at(-1)).toBe(document.activeElement)
    expect(document.activeElement?.textContent).toContain('const context = x')
    pane.scrollTop = 900; pane.scrollLeft = 80
    await act(async () => document.querySelector<HTMLButtonElement>(`button[data-side="${side}"][data-source-line="7"]`)!.click())
    expect(button('English').getAttribute('aria-selected')).toBe('true')
    expect(scrolled.at(-1)?.getAttribute('data-source-line')).toBe('6')
    expect(pane.scrollTop).toBe(317)
    expect(pane.scrollLeft).toBe(24)
    expect(document.activeElement).toBe(document.querySelector(`[data-side="${side}"][data-source-line="6"] button`))
    await click('Next change')
    expect(document.querySelector('[data-source-selected]')).toBeNull()
  } finally { scrollIntoView.mockRestore() }
})
it('returns from the original code line to the saved English place after browsing other changes', async () => {
  await render()
  expect(button('← Back to English')).toBeUndefined()
  // Even source retained literally in English mode has a return location.
  const sentence = document.querySelector<HTMLButtonElement>('[data-side="after"][data-source-line="1"] button')!
  const pane = document.querySelector<HTMLElement>('.cl-comparison-wrap')!
  pane.scrollTop = 413; pane.scrollLeft = 17
  await act(async () => sentence.click())
  expect(button('← Back to English')).toBeUndefined()
  expect(document.querySelector('button[data-side="after"][data-source-line="1"]')).not.toBeNull()
  await click('Next change')
  expect(document.body.textContent).toContain('Change 2 of 2')
  pane.scrollTop = 1900; pane.scrollLeft = 60
  await act(async () => document.querySelector<HTMLButtonElement>('button[data-side="after"][data-source-line="1"]')!.click())
  expect(button('English').getAttribute('aria-selected')).toBe('true')
  expect(pane.scrollTop).toBe(413)
  expect(pane.scrollLeft).toBe(17)
  expect(document.body.textContent).toContain('Change 1 of 2')
  expect(document.activeElement).toBe(document.querySelector('[data-side="after"][data-source-line="1"] button'))
  expect(button('← Back to English')).toBeUndefined()
  // A later toggle saves the reader's new English scroll position.
  pane.scrollTop = 522; pane.scrollLeft = 30
  await click('Code')
  await click('English')
  expect(pane.scrollTop).toBe(522)
  expect(pane.scrollLeft).toBe(30)
  await click('Next change')
  await click('Code')
  expect(document.querySelector('button[data-source-line]')).toBeNull()
})
it('opens the requested suite and source line and keeps file focus on live refresh', async () => {
  const onFocus = vi.fn()
  await render({ features: [feature('beta'), feature('alpha', ['e2e/a.spec.ts', 'e2e/b.spec.ts'])], focusFeature: 'alpha', focus: { file: 'e2e/b.spec.ts', line: 3 }, onFocus })
  expect(api.getTestFileReview).toHaveBeenLastCalledWith('alpha', 'e2e/b.spec.ts', undefined)
  await click('Code')
  expect(onFocus).toHaveBeenCalledWith({ file: 'e2e/b.spec.ts', line: 3, mode: 'code' })
})
it('re-fetches changed source rather than retaining cached line highlights', async () => {
  await render()
  const next = feature(); next.dirty!.specs[0].affectedTests.push('new')
  await render({ features: [next] })
  expect(api.getTestFileReview).toHaveBeenCalledTimes(2)
})
it('commits every changed file in the selected suite and retains a saved receipt when dirty state clears', async () => {
  const onClose = vi.fn()
  await render({ features: [feature('alpha', ['e2e/a.spec.ts', 'e2e/b.spec.ts']), feature('beta')], onClose })
  await click('Commit suite · 2 files')
  expect(api.commitDirtySpecs).toHaveBeenCalledExactlyOnceWith('alpha')
  expect(api.adoptSpecEdits).not.toHaveBeenCalled()
  await render({ features: [], onClose })
  expect(document.body.textContent).toContain('Saved in Git · 2 files in alpha')
  expect(document.body.textContent).toContain('No uncommitted test edits remain')
  expect(onClose).not.toHaveBeenCalled()
})
it('does not claim a no-op commit succeeded', async () => {
  vi.mocked(api.commitDirtySpecs).mockResolvedValue({ committed: false, reason: 'no modified specs' })
  await render(); await click('Commit suite · 1 file')
  expect(document.querySelector('[role="alert"]')?.textContent).toBe('no modified specs')
  expect(button('Commit suite · 1 file').disabled).toBe(false)
})
it('surfaces a failed commit and allows retry', async () => {
  vi.mocked(api.commitDirtySpecs).mockRejectedValue(new Error('Git rejected the commit'))
  await render(); await click('Commit suite · 1 file')
  expect(document.body.textContent).toContain('Git rejected the commit')
  expect(button('Commit suite · 1 file').disabled).toBe(false)
})
it('keeps restore and adopt explicit and bound to the selected live run', async () => {
  await render({ pendingRuns: [run], focusRunDetail: detail })
  await click('Restore original tests'); await click('Adopt & rerun')
  expect(api.restoreSpecEdits).toHaveBeenCalledWith('run-1')
  expect(api.adoptSpecEdits).toHaveBeenCalledWith('run-1')
  expect(api.commitDirtySpecs).not.toHaveBeenCalled()
})
it('uses the selected run snapshot only when reviewing differences from that run', async () => {
  await render({ pendingRuns: [run], focusRunDetail: detail, focusRunId: 'run-1' })
  expect(api.getTestFileReview).toHaveBeenLastCalledWith('alpha', 'e2e/a.spec.ts', undefined)
  await act(async () => { const select = document.querySelector<HTMLSelectElement>('[aria-label="Compare with"]')!; select.value = 'run'; select.dispatchEvent(new Event('change', { bubbles: true })) })
  expect(api.getTestFileReview).toHaveBeenLastCalledWith('alpha', 'e2e/a.spec.ts', 'run-1')
})
it('supports a committed file that differs from a completed run without showing live-run levers', async () => {
  await render({ features: [], pendingRuns: [{ ...run, status: 'passed' }], focusRunId: 'run-1', focus: { file: 'e2e/a.spec.ts', baseline: 'run' } })
  expect(api.getTestFileReview).toHaveBeenCalledWith('alpha', 'e2e/a.spec.ts', 'run-1')
  expect(button('Adopt & rerun')).toBeUndefined()
  expect(button('Commit suite · 1 file')).toBeUndefined()
})
it('discloses missing source and retries instead of presenting it as removed code', async () => {
  vi.mocked(api.getTestFileReview).mockRejectedValueOnce(new Error('Snapshot unavailable'))
  await render()
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('Snapshot unavailable')
  expect(document.querySelector('del')).toBeNull()
  expect(document.body.textContent).not.toContain('This file matches')
  expect(document.body.textContent).not.toContain('No changes')
  expect(button('Next change').disabled).toBe(true)
  await click('Retry')
  expect(document.querySelector('table')).not.toBeNull()
})
it('does not claim the baseline matches while source is still loading', async () => {
  vi.mocked(api.getTestFileReview).mockReturnValue(new Promise(() => {}))
  await render()
  expect(document.querySelector('[role="status"]')?.textContent).toContain('Loading complete test source')
  expect(document.body.textContent).not.toContain('This file matches')
  expect(document.body.textContent).not.toContain('No changes')
})
it('opens the existing editor at the test source without creating a new screen', async () => {
  vi.mocked(api.openEditor).mockResolvedValue({ opened: true, editor: 'cursor' })
  await render(); await click('Edit in editor')
  expect(api.openEditor).toHaveBeenCalledWith({ file: '/tmp/features/alpha/e2e/a.spec.ts', line: 5 })
})
it('retains the advisory disclosure and an honest empty cold load', async () => {
  await render({ features: [] })
  expect(document.body.textContent).toContain('No changed test files')
  await click('About assessments')
  expect(document.querySelector('[data-testid="dirty-review-hint-copy"]')?.textContent).toContain('Advisory')
})

it('starts a linked file at its requested change and persists navigation through the existing focus callback', async () => {
  const onFocus = vi.fn()
  await render({ focus: { file: 'e2e/a.spec.ts', line: 7, mode: 'code' }, onFocus })
  expect(document.body.textContent).toContain('Change 2 of 2')
  await act(async () => button('Previous change').click())
  expect(onFocus).toHaveBeenLastCalledWith({ file: 'e2e/a.spec.ts', line: 5, mode: 'code' })
  expect(document.body.textContent).toContain('Change 1 of 2')
})
it('shows one accurate whole-file empty state when the selected baseline matches', async () => {
  const review = testFileReview(); review.before = review.after; review.patch = ''; review.assessment.tests = []
  vi.mocked(api.getTestFileReview).mockResolvedValue(review)
  await render()
  expect(document.body.textContent).toContain('This file matches Git HEAD.')
  expect(button('Previous change').disabled).toBe(true)
  expect(button('Next change').disabled).toBe(true)
  expect(document.body.textContent).not.toContain('Choose another test')
})
