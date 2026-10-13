import { runCaptureCases } from '@shared/__fixtures__/run-capture-state'
// @vitest-environment happy-dom

import { act } from 'react'
import type { Root } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RepoBranchSnapshot } from '@shared/run-manifest'
import type { RunFixCapture, RunPrAttempt } from '@shared/run-state'
import { ChangesTab, rosterFor } from './ChangesTab'
import { mountRoot } from '@/test-helpers/mount-root'

const mocks = vi.hoisted(() => ({
  getRunApplyPreflight: vi.fn(),
  applyRunFixes: vi.fn(),
  openRunRepo: vi.fn(),
  getRunPrPreflight: vi.fn(),
  proposeRunPr: vi.fn(),
  getRunFixPatch: vi.fn(),
  openEditor: vi.fn(),
}))
vi.mock('@/shared/api/runs', () => ({
  getRunApplyPreflight: mocks.getRunApplyPreflight,
  applyRunFixes: mocks.applyRunFixes,
  openRunRepo: mocks.openRunRepo,
  getRunPrPreflight: mocks.getRunPrPreflight,
  proposeRunPr: mocks.proposeRunPr,
  getRunFixPatch: mocks.getRunFixPatch,
}))
vi.mock('@/shared/api/workspace', () => ({
  openEditor: mocks.openEditor,
}))

const stoppedRun = { status: 'failed', endedAt: '2026-08-01T00:00:00.000Z' } as const

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

const target = (over: Partial<{ repoName: string; repoRoot: string; ready: boolean; reason: string; foreignDirty: string[]; branch: string | null; inRepo: 'absent' | 'uncommitted' | 'committed' }> = {}) => ({
  repoName: 'mighty-cns',
  repoRoot: '/repos/cns',
  ready: true,
  foreignDirty: [] as string[],
  branch: 'main',
  ...over,
})

let container: HTMLDivElement
let root: Root

mountRoot({ attach: true, onMount: (mounted) => ({ container, root } = mounted) })
beforeEach(() => {
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
    await render(<ChangesTab run={stoppedRun} runId="r1" fixCapture={fixCapture} repoBranches={repoBranches} />)
    // The untouched repo is the point: "which of these did the agent edit?" is
    // answered by a labelled card, never by a repo quietly missing from the list.
    expect(container.querySelectorAll('[data-testid^="changes-repo-"]')).toHaveLength(3)
    expect(text('changes-state-billing')).toContain('unchanged')
    expect(text('changes-state-mighty-cns')).toContain('3 files')
    expect(text('changes-state-gateway')).toContain('1 file')
  })

  it('sorts the repaired repos above the untouched ones', async () => {
    await render(<ChangesTab run={stoppedRun} runId="r1" fixCapture={fixCapture} repoBranches={repoBranches} />)
    const order = [...container.querySelectorAll('[data-testid^="changes-repo-"]')]
      .map((el) => el.getAttribute('data-testid'))
    expect(order).toEqual(['changes-repo-mighty-cns', 'changes-repo-gateway', 'changes-repo-billing'])
  })

  it('opens the first repaired repo on its patch, in the code editor the repair cycles use', async () => {
    await render(<ChangesTab run={stoppedRun} runId="r1" fixCapture={fixCapture} repoBranches={repoBranches} />)
    expect(mocks.getRunFixPatch).toHaveBeenCalledTimes(1)
    expect(mocks.getRunFixPatch).toHaveBeenCalledWith('r1', 'mighty-cns')
    const patch = container.querySelector('[data-testid="changes-patch-mighty-cns"]')!
    expect([...patch.querySelectorAll('th')].map((cell) => cell.textContent)).toEqual(['Before this run', 'After this run'])
    expect(patch.textContent).toContain('broken()')
    expect(patch.textContent).toContain('fixed()')
    expect(patch.textContent).toContain('− Removed+ Added')
    // The other repos stay closed until asked for.
    expect(container.querySelector('[data-testid="changes-patch-gateway"]')).toBeNull()
    expect(container.querySelector('[data-testid="changes-toggle-gateway"]')?.getAttribute('aria-expanded')).toBe('false')
  })

  it('opens and closes a repo from its header', async () => {
    await render(<ChangesTab run={stoppedRun} runId="r1" fixCapture={fixCapture} repoBranches={repoBranches} />)
    await click('changes-toggle-gateway')
    expect(mocks.getRunFixPatch).toHaveBeenCalledWith('r1', 'gateway')
    expect(container.querySelector('[data-testid="changes-patch-gateway"]')).not.toBeNull()
    await click('changes-toggle-mighty-cns')
    expect(container.querySelector('[data-testid="changes-patch-mighty-cns"]')).toBeNull()
    // An untouched repo has nothing to open.
    expect(container.querySelector('[data-testid="changes-toggle-billing"]')).toBeNull()
    expect(text('changes-state-billing')).toBe('unchanged')
  })

  it('keeps a route to the patch for a capture that recorded no file names', async () => {
    // Runs from before `fileNames` existed carry a true count and nothing else
    // (one real workspace run: 87 files, no names). The card can name nothing,
    // so the patch is what it has to offer — it must still offer it.
    await render(<ChangesTab run={stoppedRun} runId="r1" fixCapture={{
      ...fixCapture,
      repos: [{ ...fixCapture.repos[0], files: 87, fileNames: [] }],
    }} />)
    expect(text('changes-state-mighty-cns')).toBe('87 files')
    expect(text('changes-patch-mighty-cns')).toContain('fixed()')
  })

  it('keeps an edited test file in view — a repair fixes the app, not the test', async () => {
    const many = [
      'e2e/checkout.spec.ts',
      ...Array.from({ length: 9 }, (_, i) => `src/api/f${i}.ts`),
    ]
    await render(<ChangesTab run={stoppedRun} runId="r1" fixCapture={{
      ...fixCapture,
      repos: [{ ...fixCapture.repos[0], files: 10, fileNames: many }],
    }} />)
    const flagged = text('changes-tests-mighty-cns')
    expect(flagged).toContain('Edits 1 test file')
    expect(flagged).toContain('e2e/checkout.spec.ts')
    expect(flagged).not.toContain('src/api/f0.ts')
    // Closing the editor leaves the warning standing.
    await click('changes-toggle-mighty-cns')
    expect(text('changes-tests-mighty-cns')).toContain('e2e/checkout.spec.ts')
  })

  it('says how many tests were edited when there is more than one', async () => {
    await render(<ChangesTab run={stoppedRun} runId="r1" fixCapture={{
      ...fixCapture,
      repos: [{ ...fixCapture.repos[0], files: 2, fileNames: ['e2e/a.spec.ts', 'src/b.test.ts'] }],
    }} />)
    expect(text('changes-tests-mighty-cns')).toContain('Edits 2 test files')
  })

  it('says plainly that nothing changed rather than rendering an empty tab', async () => {
    await render(<ChangesTab run={stoppedRun} runId="r1" />)
    expect(text('changes-empty')).toContain('Nothing needed changing')
    // And it asks nothing of the server when there is nothing to apply.
    expect(mocks.getRunApplyPreflight).not.toHaveBeenCalled()
  })

  it('separates "the agent changed nothing" from "nothing needed changing"', async () => {
    // A healed run with no capture is not the same fact as a first-time pass,
    // and the green "all good" reading would be wrong for it.
    await render(<ChangesTab run={stoppedRun} runId="r1" healCycles={2} />)
    expect(text('changes-empty')).toContain('No code changes were captured')
    expect(text('changes-empty')).toContain('Heal Agent tab')
  })

  it('lands the repair in the repo BEFORE opening it', async () => {
    const order: string[] = []
    mocks.applyRunFixes.mockImplementation(async () => { order.push('apply'); return { results: [{ repoName: 'mighty-cns', ok: true }], allOk: true } })
    mocks.openRunRepo.mockImplementation(async () => { order.push('open'); return { opened: true, path: '/repos/cns', editor: 'vscode' } })

    await render(<ChangesTab run={stoppedRun} runId="r1" fixCapture={fixCapture} />)
    await click('changes-open-repo-mighty-cns')

    // Opening first would show the user an unchanged repo and read as a no-op.
    expect(order).toEqual(['apply', 'open'])
    expect(mocks.applyRunFixes).toHaveBeenCalledWith('r1', 'mighty-cns')
    // The editor id (`vscode`) is a command name, not something to show a user.
    expect(text('changes-open-done-mighty-cns')).toContain('opened in VS Code')
  })

  it("says whether the repair is in the user's repo yet, and re-reads it after opening", async () => {
    mocks.getRunApplyPreflight.mockResolvedValue({ targets: [target({ inRepo: 'absent' })] })
    mocks.applyRunFixes.mockResolvedValue({ results: [{ repoName: 'mighty-cns', ok: true }], allOk: true })
    mocks.openRunRepo.mockResolvedValue({ opened: true, path: '/repos/cns', editor: 'vscode' })
    await render(<ChangesTab run={stoppedRun} runId="r1" fixCapture={{ ...fixCapture, repos: [fixCapture.repos[0]] }} />)
    // A diff on screen must not read as a change already made.
    expect(text('changes-in-repo-mighty-cns')).toBe('Not in your repo')
    mocks.getRunApplyPreflight.mockResolvedValue({ targets: [target({ inRepo: 'uncommitted' })] })
    await click('changes-open-repo-mighty-cns')
    expect(text('changes-in-repo-mighty-cns')).toBe('In your repo, uncommitted')
  })

  it('says when the repo already holds the repair, committed', async () => {
    mocks.getRunApplyPreflight.mockResolvedValue({ targets: [target({ inRepo: 'committed' })] })
    await render(<ChangesTab run={stoppedRun} runId="r1" fixCapture={{ ...fixCapture, repos: [fixCapture.repos[0]] }} />)
    expect(text('changes-in-repo-mighty-cns')).toBe('Already in your repo')
  })

  it('warns before mixing the repair into work the user already had going', async () => {
    mocks.getRunApplyPreflight.mockResolvedValue({
      targets: [target({ foreignDirty: ['src/wip.ts', 'README.md'], branch: 'feat/pricing' })],
    })
    await render(<ChangesTab run={stoppedRun} runId="r1" fixCapture={{ ...fixCapture, repos: [fixCapture.repos[0]] }} />)
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
    await render(<ChangesTab run={stoppedRun} runId="r1" fixCapture={{ ...fixCapture, repos: [fixCapture.repos[0]] }} />)
    await click('changes-open-repo-mighty-cns')
    expect(container.textContent).not.toContain('already has uncommitted changes')
    expect(mocks.applyRunFixes).toHaveBeenCalled()
  })

  it('cancelling the warning applies nothing', async () => {
    mocks.getRunApplyPreflight.mockResolvedValue({ targets: [target({ foreignDirty: ['src/wip.ts'] })] })
    await render(<ChangesTab run={stoppedRun} runId="r1" fixCapture={{ ...fixCapture, repos: [fixCapture.repos[0]] }} />)
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
    await render(<ChangesTab run={stoppedRun} runId="r1" fixCapture={{ ...fixCapture, repos: [fixCapture.repos[0]] }} />)
    await click('changes-open-repo-mighty-cns')
    expect(text('changes-open-error-mighty-cns')).toContain('patch does not apply')
    expect(mocks.openRunRepo).not.toHaveBeenCalled()
  })

  it('reports an editor that would not launch', async () => {
    mocks.openRunRepo.mockResolvedValue({ opened: false, path: '/repos/cns', error: 'code: command not found' })
    await render(<ChangesTab run={stoppedRun} runId="r1" fixCapture={{ ...fixCapture, repos: [fixCapture.repos[0]] }} />)
    await click('changes-open-repo-mighty-cns')
    expect(text('changes-open-error-mighty-cns')).toContain('command not found')
  })

  it('surfaces a rejected request rather than hanging on "Opening…"', async () => {
    mocks.applyRunFixes.mockRejectedValue(new Error('run not found'))
    await render(<ChangesTab run={stoppedRun} runId="r1" fixCapture={{ ...fixCapture, repos: [fixCapture.repos[0]] }} />)
    await click('changes-open-repo-mighty-cns')
    expect(text('changes-open-error-mighty-cns')).toContain('run not found')
  })

  it('drops the open action when the repo has moved away, and keeps the patch and the PR', async () => {
    mocks.getRunApplyPreflight.mockResolvedValue({
      targets: [target({ ready: false, reason: 'the repo path no longer exists' })],
    })
    await render(<ChangesTab run={stoppedRun} runId="r1" fixCapture={{ ...fixCapture, repos: [fixCapture.repos[0]] }} />)
    // A dead disabled button is a dead end, and a row restating it is noise:
    // the patch stays readable and the PR dialog explains its own preflight.
    expect(container.querySelector('[data-testid="changes-open-repo-mighty-cns"]')).toBeNull()
    expect(container.textContent).not.toContain('no longer exists')
    expect(mocks.getRunFixPatch).toHaveBeenCalledWith('r1', 'mighty-cns')
    expect(container.querySelector('[data-testid="changes-patch-mighty-cns"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="changes-propose-mighty-cns"]')).not.toBeNull()
  })

  it('reports a patch that is no longer on disk instead of an empty editor', async () => {
    mocks.getRunApplyPreflight.mockResolvedValue({
      targets: [target({ ready: false, reason: 'the repo path no longer exists' })],
    })
    mocks.getRunFixPatch.mockRejectedValue(new Error('the patch file is no longer on disk'))
    await render(<ChangesTab run={stoppedRun} runId="r1" fixCapture={{ ...fixCapture, repos: [fixCapture.repos[0]] }} />)
    expect(text('changes-patch-error-mighty-cns')).toContain('no longer on disk')
  })

  it('withholds apply while preflight is unreadable and offers an explicit retry', async () => {
    mocks.getRunApplyPreflight.mockRejectedValue(new Error('offline'))
    await render(<ChangesTab run={stoppedRun} runId="r1" fixCapture={{ ...fixCapture, repos: [fixCapture.repos[0]] }} />)
    expect(container.querySelector<HTMLButtonElement>('[data-testid="changes-open-repo-mighty-cns"]')?.disabled).toBe(true)
    expect(container.textContent).toContain('Repository status unavailable: offline')
    await click('changes-open-repo-mighty-cns')
    expect(mocks.applyRunFixes).not.toHaveBeenCalled()
    mocks.getRunApplyPreflight.mockResolvedValue({ targets: [target()] })
    await act(async () => { Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Refresh status')?.click() })
    expect(container.querySelector<HTMLButtonElement>('[data-testid="changes-open-repo-mighty-cns"]')?.disabled).toBe(false)
  })

  it('links the draft PR the run opened by itself', async () => {
    const prAttempt: RunPrAttempt = { at: 'T', auto: true, results: [{ repoName: 'mighty-cns', ok: true, url: 'https://gh/pr/7' }] }
    await render(
      <ChangesTab run={stoppedRun}
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
      <ChangesTab run={stoppedRun}
        runId="r1"
        fixCapture={{ ...fixCapture, repos: [fixCapture.repos[0]] }}
        prAttempt={{ at: 'T', auto: true, results: [{ repoName: 'mighty-cns', ok: false, reason: 'gh is not signed in' }] }}
      />,
    )
    expect(text('changes-pr-blocked-mighty-cns')).toContain('gh is not signed in')
  })

  it('turns a preflight code into prose, and offers no second retry button', async () => {
    await render(
      <ChangesTab run={stoppedRun}
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

  it('opens the propose dialog from a repo card', async () => {
    await render(<ChangesTab run={stoppedRun} runId="r1" fixCapture={{ ...fixCapture, repos: [fixCapture.repos[0]] }} />)
    await click('changes-propose-mighty-cns')
    expect(mocks.getRunPrPreflight).toHaveBeenCalledWith('r1')
  })

  it('shows live edits but unlocks PR only after the run stops', async () => {
    const live = { ...fixCapture, provisional: true, repos: [fixCapture.repos[0]] }
    await render(<ChangesTab run={{ status: 'running' }} runId="r1" fixCapture={live} worktrees={{ 'mighty-cns': '/runs/r1/worktrees/cns' }} />)
    expect(text('changes-patch-mighty-cns')).toContain('fixed()')
    // A newer capture re-reads the open patch, so live edits reach it.
    mocks.getRunFixPatch.mockResolvedValue({ repoName: 'mighty-cns', patchPath: '/logs/runs/r1/fixes/mighty-cns.patch', files: 3, diff: 'diff --git a/src/api/orders.ts b/src/api/orders.ts\n@@ -1,3 +1,3 @@\n-  broken()\n+  fixedAgain()\n' })
    await render(<ChangesTab run={{ status: 'running' }} runId="r1" fixCapture={{ ...live, capturedAt: '2026-10-13T00:00:09.000Z' }} worktrees={{ 'mighty-cns': '/runs/r1/worktrees/cns' }} />)
    expect(text('changes-patch-mighty-cns')).toContain('fixedAgain()')
    expect(container.querySelector('[data-testid="changes-repo-mighty-cns"] [title="/runs/r1/worktrees/cns"]')).not.toBeNull()
    const button = container.querySelector<HTMLButtonElement>('[data-testid="changes-propose-mighty-cns"]')!
    expect(button.disabled).toBe(true)
    expect(button.parentElement?.title).toContain('after this run stops')
    await click('changes-propose-mighty-cns')
    expect(mocks.getRunPrPreflight).not.toHaveBeenCalled()

    await click('changes-open-repo-mighty-cns')
    expect(mocks.openRunRepo).toHaveBeenCalledWith('r1', 'mighty-cns')
    expect(mocks.applyRunFixes).not.toHaveBeenCalled()
    expect(text('changes-open-done-mighty-cns')).toContain('Opened live run worktree')

    await render(<ChangesTab run={stoppedRun} runId="r1" fixCapture={{ ...fixCapture, repos: [fixCapture.repos[0]] }} />)
    expect(button.disabled).toBe(false)
    await click('changes-propose-mighty-cns')
    expect(mocks.getRunPrPreflight).toHaveBeenCalledWith('r1')
  })

  it('waits for edits instead of claiming none were made while healing', async () => {
    await render(<ChangesTab run={{ status: 'running' }} runId="r1" healCycles={1} />)
    expect(text('changes-empty')).toContain('Waiting for code changes')
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


it.each(runCaptureCases)('shares capture eligibility with server guards: $name', async ({ run, finalCapture }) => {
  await render(<ChangesTab run={run} runId="r1" fixCapture={{ ...fixCapture, ...run.fixCapture }} />)
  const propose = container.querySelector<HTMLButtonElement>('[data-testid="changes-propose-mighty-cns"]')!
  expect(propose.disabled).toBe(!finalCapture)
  expect(mocks.getRunApplyPreflight.mock.calls.length > 0).toBe(finalCapture)
})

it('revokes final actions on an open view when a newer provisional capture arrives', async () => {
  await render(<ChangesTab run={stoppedRun} runId="r1" fixCapture={fixCapture} />)
  await click('changes-propose-mighty-cns')
  expect(container.querySelector('[role="dialog"]')).not.toBeNull()
  await render(<ChangesTab run={stoppedRun} runId="r1" fixCapture={{ ...fixCapture, provisional: true }} />)
  expect(container.querySelector('[role="dialog"]')).toBeNull()
  expect(container.querySelector<HTMLButtonElement>('[data-testid="changes-propose-mighty-cns"]')!.disabled).toBe(true)
})
