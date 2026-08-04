// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunFixCapture } from '@/shared/api/types'
import { FixesCapturedPanel } from './FixesCapturedPanel'

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
  capturedAt: '2026-07-24T00:00:00.000Z',
  repos: [{
    repoName: 'merchant-pass',
    patchPath: '/logs/runs/r1/fixes/merchant-pass.patch',
    patchFile: 'merchant-pass.patch',
    repoRoot: '/Users/me/mpass',
    baseSha: 'abc123',
    files: 3,
    fileNames: ['src/pass.ts', 'src/redeem.ts', 'src/index.ts'],
  }],
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  mocks.getRunApplyPreflight.mockReset().mockResolvedValue({
    targets: [{ repoName: 'merchant-pass', repoRoot: '/Users/me/mpass', ready: true, foreignDirty: [], branch: 'main' }],
  })
  mocks.applyRunFixes.mockReset().mockResolvedValue({ results: [{ repoName: 'merchant-pass', ok: true }], allOk: true })
  mocks.openRunRepo.mockReset().mockResolvedValue({ opened: true, path: '/Users/me/mpass', editor: 'vscode' })
  mocks.getRunPrPreflight.mockReset()
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const render = async (ui: React.ReactElement): Promise<void> => {
  await act(async () => { root.render(ui) })
}

describe('FixesCapturedPanel (R80)', () => {
  it('names the repaired repo and the files it touched', async () => {
    await render(<FixesCapturedPanel fixCapture={fixCapture} runId="r1" />)
    const text = container.textContent ?? ''
    expect(text).toContain('merchant-pass')
    expect(text).toContain('3 files')
    expect(text).toContain('src/redeem.ts')
  })

  it('renders nothing at all when the capture lists no repos', async () => {
    await render(<FixesCapturedPanel fixCapture={{ capturedAt: 'T', repos: [] }} runId="r1" />)
    expect(container.querySelector('[data-testid="fixes-captured"]')).toBeNull()
  })

  it('offers the same open-in-editor action the run detail does', async () => {
    // The stage and the drill-through render one shared card, so a repair
    // cannot end up with different actions depending on where it is read.
    await render(<FixesCapturedPanel fixCapture={fixCapture} runId="r1" />)
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="changes-open-repo-merchant-pass"]')?.click()
    })
    expect(mocks.applyRunFixes).toHaveBeenCalledWith('r1', 'merchant-pass')
    expect(mocks.openRunRepo).toHaveBeenCalledWith('r1', 'merchant-pass')
    expect(container.querySelector('[data-testid="changes-open-done-merchant-pass"]')?.textContent)
      .toContain('opened in vscode')
  })

  it('warns here too before mixing into the user’s own uncommitted work', async () => {
    mocks.getRunApplyPreflight.mockResolvedValue({
      targets: [{ repoName: 'merchant-pass', repoRoot: '/Users/me/mpass', ready: true, foreignDirty: ['wip.ts'], branch: 'main' }],
    })
    await render(<FixesCapturedPanel fixCapture={fixCapture} runId="r1" />)
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="changes-open-repo-merchant-pass"]')?.click()
    })
    expect(container.textContent).toContain('already has uncommitted changes')
    expect(mocks.applyRunFixes).not.toHaveBeenCalled()
  })

  it('links out to an already-opened PR per repo', async () => {
    await render(
      <FixesCapturedPanel
        fixCapture={fixCapture}
        runId="r1"
        proposedPrs={[{ repoName: 'merchant-pass', url: 'https://github.com/o/mpass/pull/9', branch: 'canary-lab/fix', base: 'main', createdAt: 'T' }]}
      />,
    )
    const line = container.querySelector('[data-testid="changes-pr-merchant-pass"]')
    expect(line?.querySelector('a')?.getAttribute('href')).toBe('https://github.com/o/mpass/pull/9')
    // The stage never proposes automatically, so it says so plainly.
    expect(line?.textContent).toContain('Pull request opened')
  })

  it('opens the Propose-PR dialog and preflights on open', async () => {
    mocks.getRunPrPreflight.mockResolvedValue({ gh: { installed: true, authenticated: true, account: 'me' }, anyPushable: true, repos: [{ repoName: 'merchant-pass', repoRoot: '/r', origin: { owner: 'o', name: 'mpass', host: 'github.com' }, base: 'main', pushable: true }] })
    await render(<FixesCapturedPanel fixCapture={fixCapture} runId="r1" />)
    expect(container.querySelector('[data-testid="propose-pr-dialog"]')).toBeNull()
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="changes-propose-merchant-pass"]')?.click() })
    expect(container.querySelector('[data-testid="propose-pr-dialog"]')).toBeTruthy()
    expect(mocks.getRunPrPreflight).toHaveBeenCalledWith('r1')
  })
})
