// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunFixCapture } from '../../../shared/api/types'
import { FixesCapturedPanel } from './FixesCapturedPanel'

const mocks = vi.hoisted(() => ({ applyRunFixes: vi.fn(), openEditor: vi.fn(), getRunPrPreflight: vi.fn(), proposeRunPr: vi.fn() }))
vi.mock('../../../shared/api/client', () => mocks)

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const fixCapture: RunFixCapture = {
  capturedAt: '2026-07-24T00:00:00.000Z',
  repos: [{ repoName: 'merchant-pass', patchPath: '/logs/runs/r1/fixes/merchant-pass.patch', patchFile: 'merchant-pass.patch', repoRoot: '/Users/me/mpass', baseSha: 'abc123', files: 3 }],
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  mocks.applyRunFixes.mockReset()
  mocks.openEditor.mockReset().mockResolvedValue({ opened: true, editor: 'vscode' })
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('FixesCapturedPanel (R80)', () => {
  it('always surfaces the patch path and per-repo file count', () => {
    act(() => root.render(<FixesCapturedPanel fixCapture={fixCapture} runId="r1" />))
    const text = container.textContent ?? ''
    expect(text).toContain('merchant-pass')
    expect(text).toContain('3 files')
    expect(text).toContain('/logs/runs/r1/fixes/merchant-pass.patch')
  })

  it('opens the patch in the editor', () => {
    act(() => root.render(<FixesCapturedPanel fixCapture={fixCapture} runId="r1" />))
    act(() => { container.querySelector<HTMLButtonElement>('[data-testid="fix-open-editor-merchant-pass"]')?.click() })
    expect(mocks.openEditor).toHaveBeenCalledWith({ file: '/logs/runs/r1/fixes/merchant-pass.patch' })
  })

  it('applies locally and shows the success result', async () => {
    mocks.applyRunFixes.mockResolvedValue({ results: [{ repoName: 'merchant-pass', ok: true }], allOk: true })
    act(() => root.render(<FixesCapturedPanel fixCapture={fixCapture} runId="r1" />))
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="fix-apply-locally"]')?.click() })
    expect(mocks.applyRunFixes).toHaveBeenCalledWith('r1')
    expect(container.querySelector('[data-testid="fix-apply-result"]')?.textContent).toMatch(/applied/i)
  })

  it('shows the per-repo reason when apply reports a conflict', async () => {
    mocks.applyRunFixes.mockResolvedValue({ results: [{ repoName: 'merchant-pass', ok: false, reason: 'patch does not apply' }], allOk: false })
    act(() => root.render(<FixesCapturedPanel fixCapture={fixCapture} runId="r1" />))
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="fix-apply-locally"]')?.click() })
    expect(container.querySelector('[data-testid="fix-apply-result"]')?.textContent).toContain('patch does not apply')
  })

  it('links out to an already-opened PR per repo', () => {
    act(() => root.render(
      <FixesCapturedPanel
        fixCapture={fixCapture}
        runId="r1"
        proposedPrs={[{ repoName: 'merchant-pass', url: 'https://github.com/o/mpass/pull/9', branch: 'canary-lab/fix', base: 'main', createdAt: 'T' }]}
      />,
    ))
    const link = container.querySelector<HTMLAnchorElement>('[data-testid="fix-pr-link-merchant-pass"]')
    expect(link?.getAttribute('href')).toBe('https://github.com/o/mpass/pull/9')
  })

  it('opens the Propose-PR dialog and preflights on open', async () => {
    mocks.getRunPrPreflight.mockResolvedValue({ gh: { installed: true, authenticated: true, account: 'me' }, anyPushable: true, repos: [{ repoName: 'merchant-pass', repoRoot: '/r', origin: { owner: 'o', name: 'mpass', host: 'github.com' }, base: 'main', pushable: true }] })
    act(() => root.render(<FixesCapturedPanel fixCapture={fixCapture} runId="r1" />))
    expect(container.querySelector('[data-testid="propose-pr-dialog"]')).toBeNull()
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="fix-propose-pr"]')?.click() })
    expect(container.querySelector('[data-testid="propose-pr-dialog"]')).toBeTruthy()
    expect(mocks.getRunPrPreflight).toHaveBeenCalledWith('r1')
  })
})
