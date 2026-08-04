// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RepoBranchSnapshot, RunFixCapture, RunPrAttempt } from '@/shared/api/types'
import { ChangesTab, rosterFor } from './ChangesTab'

const mocks = vi.hoisted(() => ({
  getRunApplyPreflight: vi.fn(),
  applyRunFixes: vi.fn(),
  openRunRepo: vi.fn(),
  getRunPrPreflight: vi.fn(),
  proposeRunPr: vi.fn(),
  getRunFixPatch: vi.fn(),
  openEditor: vi.fn(),
}))
vi.mock('@/shared/api/client', () => mocks)

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const fixCapture: RunFixCapture = {
  capturedAt: '2026-08-01T00:00:00.000Z',
  repos: [
    {
      repoName: 'mighty-cns',
      patchPath: '/logs/runs/r1/fixes/mighty-cns.patch',
      patchFile: 'mighty-cns.patch',
      repoRoot: '/repos/cns',
      baseSha: 'abc123',
      files: 3,
      fileNames: ['src/api/orders.ts', 'src/api/pricing.ts', 'src/lib/tax.ts'],
    },
    {
      repoName: 'gateway',
      patchPath: '/logs/runs/r1/fixes/gateway.patch',
      patchFile: 'gateway.patch',
      repoRoot: '/repos/gw',
      baseSha: 'def456',
      files: 1,
      fileNames: ['server.ts'],
    },
  ],
}

const repoBranches: RepoBranchSnapshot[] = [
  { name: 'mighty-cns', path: '/repos/cns', branch: 'main', detached: false, dirty: false },
  { name: 'gateway', path: '/repos/gw', branch: 'main', detached: false, dirty: false },
  { name: 'billing', path: '/repos/billing', branch: 'main', detached: false, dirty: false },
]

const target = (over: Partial<{ repoName: string; repoRoot: string; ready: boolean; reason: string; foreignDirty: string[]; branch: string | null }> = {}) => ({
  repoName: 'mighty-cns',
  repoRoot: '/repos/cns',
  ready: true,
  foreignDirty: [] as string[],
  branch: 'main',
  ...over,
})

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  mocks.getRunApplyPreflight.mockReset().mockResolvedValue({ targets: [target(), target({ repoName: 'gateway', repoRoot: '/repos/gw' })] })
  mocks.applyRunFixes.mockReset().mockResolvedValue({ results: [{ repoName: 'mighty-cns', ok: true }], allOk: true })
  mocks.openRunRepo.mockReset().mockResolvedValue({ opened: true, path: '/repos/cns', editor: 'vscode' })
  mocks.getRunPrPreflight.mockReset().mockResolvedValue({ gh: { installed: true, authenticated: true }, anyPushable: true, repos: [] })
  mocks.getRunFixPatch.mockReset().mockResolvedValue({
    repoName: 'mighty-cns',
    patchPath: '/logs/runs/r1/fixes/mighty-cns.patch',
    files: 3,
    diff: 'diff --git a/src/api/orders.ts b/src/api/orders.ts\n@@ -1,3 +1,3 @@\n-  broken()\n+  fixed()\n',
  })
  mocks.openEditor.mockReset().mockResolvedValue({ opened: true, editor: 'vscode' })
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const render = async (ui: React.ReactElement): Promise<void> => {
  await act(async () => { root.render(ui) })
}
const click = async (testId: string): Promise<void> => {
  const el = container.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)
  await act(async () => { el?.click() })
}
const text = (testId: string): string => container.querySelector(`[data-testid="${testId}"]`)?.textContent ?? ''

describe('ChangesTab', () => {
  it('cards every repo the run booted, not just the ones that changed', async () => {
    await render(<ChangesTab runId="r1" fixCapture={fixCapture} repoBranches={repoBranches} />)
    // The untouched repo is the point: "which of these did the agent edit?" is
    // answered by a labelled card, never by a repo quietly missing from the list.
    expect(container.querySelectorAll('[data-testid^="changes-repo-"]')).toHaveLength(3)
    expect(text('changes-state-billing')).toContain('unchanged')
    expect(text('changes-state-mighty-cns')).toContain('3 files')
    expect(text('changes-state-gateway')).toContain('1 file')
  })

  it('sorts the repaired repos above the untouched ones', async () => {
    await render(<ChangesTab runId="r1" fixCapture={fixCapture} repoBranches={repoBranches} />)
    const order = [...container.querySelectorAll('[data-testid^="changes-repo-"]')]
      .map((el) => el.getAttribute('data-testid'))
    expect(order).toEqual(['changes-repo-mighty-cns', 'changes-repo-gateway', 'changes-repo-billing'])
  })

  it('names the changed files so they can be picked out of the editor', async () => {
    await render(<ChangesTab runId="r1" fixCapture={fixCapture} repoBranches={repoBranches} />)
    expect(text('changes-files-mighty-cns')).toContain('src/api/orders.ts')
    expect(text('changes-files-mighty-cns')).toContain('src/lib/tax.ts')
  })

  it('rolls a long file list up per directory instead of printing a wall', async () => {
    const many = [
      ...Array.from({ length: 7 }, (_, i) => `src/api/f${i}.ts`),
      ...Array.from({ length: 3 }, (_, i) => `src/lib/g${i}.ts`),
      'server.ts',
    ]
    await render(<ChangesTab runId="r1" fixCapture={{
      ...fixCapture,
      repos: [{ ...fixCapture.repos[0], files: 11, fileNames: many }],
    }} />)
    // Which AREAS the agent touched is the question that survives at this size;
    // eight arbitrary paths and a "+3 more" answered nothing.
    expect(container.querySelector('[data-testid="changes-files-mighty-cns"]')).toBeNull()
    const rollup = text('changes-dirs-mighty-cns')
    expect(rollup).toContain('src/api')
    expect(rollup).toContain('7')
    expect(rollup).toContain('src/lib')
    expect(rollup).toContain('repo root')
    // …and the full list stays one click away.
    expect(text('changes-all-files-mighty-cns')).toBe('All 11 files')
  })

  it('folds the tail of a very wide rollup into a directory count', async () => {
    const many = Array.from({ length: 9 }, (_, i) => `pkg/p${i}/index.ts`)
    await render(<ChangesTab runId="r1" fixCapture={{
      ...fixCapture,
      repos: [{ ...fixCapture.repos[0], files: 9, fileNames: many }],
    }} />)
    expect(text('changes-dirs-mighty-cns')).toContain('+3 more directories')
  })

  it('keeps a route to the patch for a capture that recorded no file names', async () => {
    // Runs from before `fileNames` existed carry a true count and nothing else
    // (one real workspace run: 87 files, no names). The card can list nothing,
    // so the patch is the only thing it has to offer — it must still offer it.
    await render(<ChangesTab runId="r1" fixCapture={{
      ...fixCapture,
      repos: [{ ...fixCapture.repos[0], files: 87, fileNames: [] }],
    }} />)
    expect(text('changes-state-mighty-cns')).toBe('87 files')
    expect(text('changes-all-files-mighty-cns')).toBe('All 87 files')
    await click('changes-all-files-mighty-cns')
    expect(text('changes-patch-files-mighty-cns')).toContain('+87 more the run didn’t record by name')
  })

  it('floats an edited test file above the fold — a repair fixes the app, not the test', async () => {
    const many = [
      'e2e/checkout.spec.ts',
      ...Array.from({ length: 9 }, (_, i) => `src/api/f${i}.ts`),
    ]
    await render(<ChangesTab runId="r1" fixCapture={{
      ...fixCapture,
      repos: [{ ...fixCapture.repos[0], files: 10, fileNames: many }],
    }} />)
    const flagged = text('changes-tests-mighty-cns')
    expect(flagged).toContain('1 test file was edited')
    expect(flagged).toContain('e2e/checkout.spec.ts')
    // The spec is called out on its own; the rollup covers only the rest.
    expect(text('changes-dirs-mighty-cns')).not.toContain('checkout.spec.ts')
  })

  it('says how many tests were edited when there is more than one', async () => {
    await render(<ChangesTab runId="r1" fixCapture={{
      ...fixCapture,
      repos: [{ ...fixCapture.repos[0], files: 2, fileNames: ['e2e/a.spec.ts', 'src/b.test.ts'] }],
    }} />)
    expect(text('changes-tests-mighty-cns')).toContain('2 test files were edited')
  })

  it('opens the captured patch from the full-list action', async () => {
    const many = Array.from({ length: 11 }, (_, i) => `src/api/f${i}.ts`)
    await render(<ChangesTab runId="r1" fixCapture={{
      ...fixCapture,
      repos: [{ ...fixCapture.repos[0], files: 11, fileNames: many }],
    }} />)
    await click('changes-all-files-mighty-cns')
    expect(mocks.getRunFixPatch).toHaveBeenCalledWith('r1', 'mighty-cns')
    // One patch holds every file in the repo, so the dialog is per repo.
    expect(text('changes-patch-dialog-mighty-cns')).toContain('11 files in one patch')
    expect(text('changes-patch-files-mighty-cns')).toContain('src/api/f10.ts')
    expect(container.textContent).toContain('-  broken()')
  })

  it('says plainly that nothing changed rather than rendering an empty tab', async () => {
    await render(<ChangesTab runId="r1" />)
    expect(text('changes-empty')).toContain('Nothing was changed in your code')
    // And it asks nothing of the server when there is nothing to apply.
    expect(mocks.getRunApplyPreflight).not.toHaveBeenCalled()
  })

  it('lands the repair in the repo BEFORE opening it', async () => {
    const order: string[] = []
    mocks.applyRunFixes.mockImplementation(async () => { order.push('apply'); return { results: [{ repoName: 'mighty-cns', ok: true }], allOk: true } })
    mocks.openRunRepo.mockImplementation(async () => { order.push('open'); return { opened: true, path: '/repos/cns', editor: 'vscode' } })

    await render(<ChangesTab runId="r1" fixCapture={fixCapture} />)
    await click('changes-open-repo-mighty-cns')

    // Opening first would show the user an unchanged repo and read as a no-op.
    expect(order).toEqual(['apply', 'open'])
    expect(mocks.applyRunFixes).toHaveBeenCalledWith('r1', 'mighty-cns')
    // The editor id (`vscode`) is a command name, not something to show a user.
    expect(text('changes-open-done-mighty-cns')).toContain('opened in VS Code')
  })

  it('warns before mixing the repair into work the user already had going', async () => {
    mocks.getRunApplyPreflight.mockResolvedValue({
      targets: [target({ foreignDirty: ['src/wip.ts', 'README.md'], branch: 'feat/pricing' })],
    })
    await render(<ChangesTab runId="r1" fixCapture={{ ...fixCapture, repos: [fixCapture.repos[0]] }} />)
    await click('changes-open-repo-mighty-cns')

    expect(mocks.applyRunFixes).not.toHaveBeenCalled()
    expect(container.textContent).toContain('already has uncommitted changes')
    expect(container.textContent).toContain('2 files')
    expect(container.textContent).toContain('feat/pricing')

    const confirm = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Apply and open')
    await act(async () => { confirm?.click() })
    expect(mocks.applyRunFixes).toHaveBeenCalledWith('r1', 'mighty-cns')
  })

  it('does not warn when the only uncommitted files are this repair', async () => {
    // Re-opening an already-applied repo must not nag: by then the tree IS
    // dirty, but only with what this run put there.
    mocks.getRunApplyPreflight.mockResolvedValue({ targets: [target({ foreignDirty: [] })] })
    await render(<ChangesTab runId="r1" fixCapture={{ ...fixCapture, repos: [fixCapture.repos[0]] }} />)
    await click('changes-open-repo-mighty-cns')
    expect(container.textContent).not.toContain('already has uncommitted changes')
    expect(mocks.applyRunFixes).toHaveBeenCalled()
  })

  it('cancelling the warning applies nothing', async () => {
    mocks.getRunApplyPreflight.mockResolvedValue({ targets: [target({ foreignDirty: ['src/wip.ts'] })] })
    await render(<ChangesTab runId="r1" fixCapture={{ ...fixCapture, repos: [fixCapture.repos[0]] }} />)
    await click('changes-open-repo-mighty-cns')
    const cancel = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Cancel')
    await act(async () => { cancel?.click() })
    expect(mocks.applyRunFixes).not.toHaveBeenCalled()
    expect(container.textContent).not.toContain('already has uncommitted changes')
  })

  it('reports a patch that no longer applies instead of claiming it opened', async () => {
    mocks.applyRunFixes.mockResolvedValue({
      results: [{ repoName: 'mighty-cns', ok: false, reason: 'patch does not apply' }],
      allOk: false,
    })
    await render(<ChangesTab runId="r1" fixCapture={{ ...fixCapture, repos: [fixCapture.repos[0]] }} />)
    await click('changes-open-repo-mighty-cns')
    expect(text('changes-open-error-mighty-cns')).toContain('patch does not apply')
    expect(mocks.openRunRepo).not.toHaveBeenCalled()
  })

  it('reports an editor that would not launch', async () => {
    mocks.openRunRepo.mockResolvedValue({ opened: false, path: '/repos/cns', error: 'code: command not found' })
    await render(<ChangesTab runId="r1" fixCapture={{ ...fixCapture, repos: [fixCapture.repos[0]] }} />)
    await click('changes-open-repo-mighty-cns')
    expect(text('changes-open-error-mighty-cns')).toContain('command not found')
  })

  it('surfaces a rejected request rather than hanging on "Opening…"', async () => {
    mocks.applyRunFixes.mockRejectedValue(new Error('run not found'))
    await render(<ChangesTab runId="r1" fixCapture={{ ...fixCapture, repos: [fixCapture.repos[0]] }} />)
    await click('changes-open-repo-mighty-cns')
    expect(text('changes-open-error-mighty-cns')).toContain('run not found')
  })

  it('swaps the open action for the patch when the repo has moved away', async () => {
    mocks.getRunApplyPreflight.mockResolvedValue({
      targets: [target({ ready: false, reason: 'the repo path no longer exists' })],
    })
    await render(<ChangesTab runId="r1" fixCapture={{ ...fixCapture, repos: [fixCapture.repos[0]] }} />)
    expect(text('changes-open-blocked-mighty-cns')).toContain('no longer exists')
    // A dead disabled button is a dead end: with no repo to open, the captured
    // patch is the only route to the repair, so it becomes the action.
    expect(container.querySelector('[data-testid="changes-open-repo-mighty-cns"]')).toBeNull()
    await click('changes-view-patch-mighty-cns')
    expect(mocks.getRunFixPatch).toHaveBeenCalledWith('r1', 'mighty-cns')
    expect(text('changes-patch-copy-mighty-cns')).toBe('Copy path')
  })

  it('reports a patch that is no longer on disk instead of an empty dialog', async () => {
    mocks.getRunApplyPreflight.mockResolvedValue({
      targets: [target({ ready: false, reason: 'the repo path no longer exists' })],
    })
    mocks.getRunFixPatch.mockRejectedValue(new Error('the patch file is no longer on disk'))
    await render(<ChangesTab runId="r1" fixCapture={{ ...fixCapture, repos: [fixCapture.repos[0]] }} />)
    await click('changes-view-patch-mighty-cns')
    expect(text('changes-patch-error-mighty-cns')).toContain('no longer on disk')
  })

  it('keeps the action alive when the preflight itself could not be read', async () => {
    // An unreadable preflight must not produce a dead button — the apply
    // reports its own failure, so the worst case is finding out on click.
    mocks.getRunApplyPreflight.mockRejectedValue(new Error('offline'))
    await render(<ChangesTab runId="r1" fixCapture={{ ...fixCapture, repos: [fixCapture.repos[0]] }} />)
    expect(container.querySelector<HTMLButtonElement>('[data-testid="changes-open-repo-mighty-cns"]')?.disabled).toBe(false)
    await click('changes-open-repo-mighty-cns')
    expect(mocks.applyRunFixes).toHaveBeenCalled()
  })

  it('links the draft PR the run opened by itself', async () => {
    const prAttempt: RunPrAttempt = { at: 'T', auto: true, results: [{ repoName: 'mighty-cns', ok: true, url: 'https://gh/pr/7' }] }
    await render(
      <ChangesTab
        runId="r1"
        fixCapture={{ ...fixCapture, repos: [fixCapture.repos[0]] }}
        proposedPrs={[{ repoName: 'mighty-cns', url: 'https://gh/pr/7', branch: 'canary-lab/fix-cns-mighty-cns', base: 'main', createdAt: 'T' }]}
        prAttempt={prAttempt}
      />,
    )
    const line = container.querySelector('[data-testid="changes-pr-mighty-cns"]')
    expect(line?.textContent).toContain('Draft pull request opened by this run')
    expect(line?.querySelector('a')?.getAttribute('href')).toBe('https://gh/pr/7')
  })

  it('explains a repo that opened no PR, instead of showing a fix with no outcome', async () => {
    await render(
      <ChangesTab
        runId="r1"
        fixCapture={{ ...fixCapture, repos: [fixCapture.repos[0]] }}
        prAttempt={{ at: 'T', auto: true, results: [{ repoName: 'mighty-cns', ok: false, reason: 'gh is not signed in' }] }}
      />,
    )
    expect(text('changes-pr-blocked-mighty-cns')).toContain('gh is not signed in')
  })

  it('turns a preflight code into prose, and offers no second retry button', async () => {
    await render(
      <ChangesTab
        runId="r1"
        fixCapture={{ ...fixCapture, repos: [fixCapture.repos[0]] }}
        prAttempt={{ at: 'T', auto: true, results: [{ repoName: 'mighty-cns', ok: false, reason: 'no-origin' }] }}
      />,
    )
    const line = container.querySelector('[data-testid="changes-pr-blocked-mighty-cns"]')
    expect(line?.textContent).toContain('This repo has no')
    expect(line?.textContent).not.toContain('no-origin')
    // The retry lived here as a button calling the very same handler as
    // `Commit & open PR…` a row above it.
    expect(line?.querySelector('button')).toBeNull()
    expect(container.querySelectorAll('[data-testid^="changes-propose-"]')).toHaveLength(1)
  })

  it('offers the patch path for a terminal, and a best-effort launch', async () => {
    const writeText = vi.fn()
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const many = Array.from({ length: 11 }, (_, i) => `src/api/f${i}.ts`)
    await render(<ChangesTab runId="r1" fixCapture={{
      ...fixCapture,
      repos: [{ ...fixCapture.repos[0], files: 11, fileNames: many }],
    }} />)
    await click('changes-all-files-mighty-cns')
    await click('changes-patch-copy-mighty-cns')
    expect(writeText).toHaveBeenCalledWith('/logs/runs/r1/fixes/mighty-cns.patch')
    expect(container.textContent).toContain('Path copied')
    await click('changes-patch-open-mighty-cns')
    expect(mocks.openEditor).toHaveBeenCalledWith({ file: '/logs/runs/r1/fixes/mighty-cns.patch' })
  })

  it('opens the propose dialog from a repo card', async () => {
    await render(<ChangesTab runId="r1" fixCapture={{ ...fixCapture, repos: [fixCapture.repos[0]] }} />)
    await click('changes-propose-mighty-cns')
    expect(mocks.getRunPrPreflight).toHaveBeenCalledWith('r1')
  })
})

describe('rosterFor', () => {
  it('keeps a repaired repo that is missing from the run roster', () => {
    // The capture is the harder evidence of the two — dropping a card that has
    // a patch behind it is the one failure this tab cannot afford.
    expect(rosterFor(['ghost'], [{ name: 'known', path: '/k', branch: 'main', detached: false, dirty: false }]))
      .toEqual(['ghost', 'known'])
  })

  it('falls back to the repaired repos alone when no roster was recorded', () => {
    expect(rosterFor(['a', 'b'])).toEqual(['a', 'b'])
  })

  it('never lists a repo twice', () => {
    expect(rosterFor(['a'], [{ name: 'a', path: '/a', branch: 'main', detached: false, dirty: false }])).toEqual(['a'])
  })
})
