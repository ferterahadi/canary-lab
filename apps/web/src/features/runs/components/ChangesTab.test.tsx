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

  it('caps a long file list and says how many it left out', async () => {
    const many = Array.from({ length: 12 }, (_, i) => `src/f${i}.ts`)
    await render(<ChangesTab runId="r1" fixCapture={{
      ...fixCapture,
      repos: [{ ...fixCapture.repos[0], files: 12, fileNames: many }],
    }} />)
    expect(text('changes-files-mighty-cns')).toContain('src/f7.ts')
    expect(text('changes-files-mighty-cns')).not.toContain('src/f8.ts')
    expect(text('changes-files-mighty-cns')).toContain('+4 more')
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
    expect(text('changes-open-done-mighty-cns')).toContain('opened in vscode')
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

  it('explains and disables the action when the repo has moved away', async () => {
    mocks.getRunApplyPreflight.mockResolvedValue({
      targets: [target({ ready: false, reason: 'the repo path no longer exists' })],
    })
    await render(<ChangesTab runId="r1" fixCapture={{ ...fixCapture, repos: [fixCapture.repos[0]] }} />)
    expect(text('changes-open-blocked-mighty-cns')).toContain('no longer exists')
    expect(container.querySelector<HTMLButtonElement>('[data-testid="changes-open-repo-mighty-cns"]')?.disabled).toBe(true)
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
