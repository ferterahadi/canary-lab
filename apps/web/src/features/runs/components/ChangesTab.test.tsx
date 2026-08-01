// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunFixCapture, RunPrAttempt } from '@/shared/api/types'
import { ChangesTab } from './ChangesTab'

const mocks = vi.hoisted(() => ({
  getRunFixPatch: vi.fn(),
  openEditor: vi.fn(),
  getRunPrPreflight: vi.fn(),
  proposeRunPr: vi.fn(),
}))
vi.mock('@/shared/api/client', () => mocks)

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const fixCapture: RunFixCapture = {
  capturedAt: '2026-08-01T00:00:00.000Z',
  repos: [
    { repoName: 'mighty-cns', patchPath: '/logs/runs/r1/fixes/mighty-cns.patch', patchFile: 'mighty-cns.patch', repoRoot: '/repos/cns', baseSha: 'abc123', files: 3 },
    { repoName: 'gateway', patchPath: '/logs/runs/r1/fixes/gateway.patch', patchFile: 'gateway.patch', repoRoot: '/repos/gw', baseSha: 'def456', files: 1 },
  ],
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  mocks.getRunFixPatch.mockReset()
  mocks.openEditor.mockReset().mockResolvedValue({ opened: true, editor: 'vscode' })
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const click = (testId: string): void => {
  const el = container.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)
  act(() => { el?.click() })
}

describe('ChangesTab', () => {
  it('lists one section per repo with its changed-file count', () => {
    act(() => root.render(<ChangesTab runId="r1" fixCapture={fixCapture} />))
    const text = container.textContent ?? ''
    expect(text).toContain('mighty-cns')
    expect(text).toContain('3 files changed')
    // Singular is not "1 files".
    expect(text).toContain('1 file changed')
    expect(container.querySelectorAll('[data-testid^="changes-repo-"]')).toHaveLength(2)
  })

  it('says plainly that nothing changed rather than rendering an empty tab', () => {
    act(() => root.render(<ChangesTab runId="r1" />))
    expect(container.querySelector('[data-testid="changes-empty"]')?.textContent)
      .toContain('Nothing was changed in your code')
  })

  it('fetches the patch only when the diff is expanded, and once', async () => {
    mocks.getRunFixPatch.mockResolvedValue({ repoName: 'gateway', patchPath: '/p', files: 1, diff: '@@ -1 +1 @@\n-old\n+new\n' })
    act(() => root.render(<ChangesTab runId="r1" fixCapture={{ ...fixCapture, repos: [fixCapture.repos[1]] }} />))
    expect(mocks.getRunFixPatch).not.toHaveBeenCalled()

    click('changes-view-diff-gateway')
    await act(async () => {})
    expect(mocks.getRunFixPatch).toHaveBeenCalledWith('r1', 'gateway')
    expect(container.textContent).toContain('+new')

    // Collapse and reopen: the fetched diff is reused, not re-requested.
    click('changes-view-diff-gateway')
    click('changes-view-diff-gateway')
    await act(async () => {})
    expect(mocks.getRunFixPatch).toHaveBeenCalledTimes(1)
  })

  it('shows the failure when the patch can no longer be read', async () => {
    mocks.getRunFixPatch.mockRejectedValue(new Error('the patch file is no longer on disk'))
    act(() => root.render(<ChangesTab runId="r1" fixCapture={{ ...fixCapture, repos: [fixCapture.repos[1]] }} />))
    click('changes-view-diff-gateway')
    await act(async () => {})
    expect(container.querySelector('[data-testid="changes-diff-error-gateway"]')?.textContent)
      .toContain('no longer on disk')
  })

  it('surfaces a non-Error rejection as its string form', async () => {
    mocks.getRunFixPatch.mockRejectedValue('gone')
    act(() => root.render(<ChangesTab runId="r1" fixCapture={{ ...fixCapture, repos: [fixCapture.repos[1]] }} />))
    click('changes-view-diff-gateway')
    await act(async () => {})
    expect(container.querySelector('[data-testid="changes-diff-error-gateway"]')?.textContent).toBe('gone')
  })

  it('links the draft PR the run opened by itself', () => {
    const prAttempt: RunPrAttempt = { at: 'T', auto: true, results: [{ repoName: 'mighty-cns', ok: true, url: 'https://gh/pr/7' }] }
    act(() => root.render(
      <ChangesTab
        runId="r1"
        fixCapture={{ ...fixCapture, repos: [fixCapture.repos[0]] }}
        proposedPrs={[{ repoName: 'mighty-cns', url: 'https://gh/pr/7', branch: 'canary-lab/fix-cns-mighty-cns', base: 'main', createdAt: 'T' }]}
        prAttempt={prAttempt}
      />,
    ))
    const line = container.querySelector('[data-testid="changes-pr-mighty-cns"]')
    expect(line?.textContent).toContain('Draft pull request opened by this run')
    expect(line?.querySelector('a')?.getAttribute('href')).toBe('https://gh/pr/7')
  })

  it('names it a plain pull request when the user opened it themselves', () => {
    act(() => root.render(
      <ChangesTab
        runId="r1"
        fixCapture={{ ...fixCapture, repos: [fixCapture.repos[0]] }}
        proposedPrs={[{ repoName: 'mighty-cns', url: 'https://gh/pr/7', branch: 'b', base: 'main', createdAt: 'T' }]}
        prAttempt={{ at: 'T', auto: false, results: [{ repoName: 'mighty-cns', ok: true, url: 'https://gh/pr/7' }] }}
      />,
    ))
    expect(container.querySelector('[data-testid="changes-pr-mighty-cns"]')?.textContent)
      .toContain('Pull request opened')
  })

  it('explains a repo that opened no PR, instead of showing a fix with no outcome', () => {
    act(() => root.render(
      <ChangesTab
        runId="r1"
        fixCapture={{ ...fixCapture, repos: [fixCapture.repos[0]] }}
        prAttempt={{ at: 'T', auto: true, results: [{ repoName: 'mighty-cns', ok: false, reason: 'gh is not signed in' }] }}
      />,
    ))
    expect(container.querySelector('[data-testid="changes-pr-blocked-mighty-cns"]')?.textContent)
      .toContain('gh is not signed in')
  })

  it('offers the manual PR route when no attempt was ever made', () => {
    act(() => root.render(<ChangesTab runId="r1" fixCapture={{ ...fixCapture, repos: [fixCapture.repos[0]] }} />))
    expect(container.querySelector('[data-testid="changes-pr-none-mighty-cns"]')?.textContent)
      .toContain('No pull request yet')
  })

  it('opens the patch in the configured editor and copies its path', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    act(() => root.render(<ChangesTab runId="r1" fixCapture={{ ...fixCapture, repos: [fixCapture.repos[0]] }} />))

    click('changes-open-editor-mighty-cns')
    expect(mocks.openEditor).toHaveBeenCalledWith({ file: '/logs/runs/r1/fixes/mighty-cns.patch' })

    click('changes-copy-path-mighty-cns')
    expect(writeText).toHaveBeenCalledWith('/logs/runs/r1/fixes/mighty-cns.patch')
  })

  it('survives an editor launch or clipboard write that rejects', async () => {
    mocks.openEditor.mockRejectedValue(new Error('no editor'))
    const writeText = vi.fn().mockRejectedValue(new Error('denied'))
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    act(() => root.render(<ChangesTab runId="r1" fixCapture={{ ...fixCapture, repos: [fixCapture.repos[0]] }} />))
    click('changes-open-editor-mighty-cns')
    click('changes-copy-path-mighty-cns')
    await act(async () => {})
    expect(container.querySelector('[data-testid="changes-repo-mighty-cns"]')).toBeTruthy()
  })

  it('opens the propose dialog from a repo row', async () => {
    mocks.getRunPrPreflight.mockResolvedValue({ gh: { installed: true, authenticated: true }, anyPushable: true, repos: [] })
    act(() => root.render(<ChangesTab runId="r1" fixCapture={{ ...fixCapture, repos: [fixCapture.repos[0]] }} />))
    const button = container.querySelector<HTMLButtonElement>('[data-testid="changes-pr-none-mighty-cns"] button')
    act(() => { button?.click() })
    await act(async () => {})
    expect(mocks.getRunPrPreflight).toHaveBeenCalledWith('r1')
  })
})
