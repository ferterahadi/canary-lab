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
const button = (label: string) => buttons().find((item) => item.textContent?.trim() === label)!
async function render(props: Partial<Parameters<typeof DirtyReviewDialog>[0]> = {}) {
  await act(async () => root.render(<DirtyReviewDialog features={[feature()]} onClose={vi.fn()} {...props} />))
}
const click = async (label: string) => act(async () => button(label).click())
it('shows a whole test with equal before/after columns, unchanged context and exact source edits', async () => {
  await render()
  await click('Code')
  expect([...document.querySelectorAll('thead th')].map((item) => item.textContent)).toEqual(['Before · Committed', 'After · Current workspace'])
  expect(document.querySelector('tbody')?.textContent).toContain('const context = x')
  expect(document.querySelector('del')?.textContent).toBe('1')
  expect(document.querySelector('ins')?.textContent).toBe('2')
  expect(document.body.textContent).toContain('Change 1 of 2')
  expect(document.body.textContent).toContain('Different expected values are not ordered by strength')
  expect(document.body.textContent).not.toContain('import { test')
})
it('keeps the selected change when switching English and Code and exposes full-file setup', async () => {
  await render()
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Next change"]')!.click())
  await click('Code'); await click('English')
  expect(document.body.textContent).toContain('Change 2 of 2')
  await act(async () => { const select = document.querySelector<HTMLSelectElement>('[aria-label="Test context"]')!; select.value = 'file'; select.dispatchEvent(new Event('change', { bubbles: true })) })
  expect(document.querySelector('tbody')?.textContent).toContain('import { test')
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
  await click('Different from this run')
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
  await click('Retry')
  expect(document.querySelector('table')).not.toBeNull()
})
it('opens the existing editor at the test source without creating a new screen', async () => {
  vi.mocked(api.openEditor).mockResolvedValue({ opened: true, editor: 'cursor' })
  await render(); await click('Edit in editor ↗')
  expect(api.openEditor).toHaveBeenCalledWith({ file: '/tmp/features/alpha/e2e/a.spec.ts', line: 3 })
})
it('retains the advisory disclosure and an honest empty cold load', async () => {
  await render({ features: [] })
  expect(document.body.textContent).toContain('No changed test files')
  await click('About this hint')
  expect(document.querySelector('[data-testid="dirty-review-hint-copy"]')?.textContent).toContain('Advisory')
})
