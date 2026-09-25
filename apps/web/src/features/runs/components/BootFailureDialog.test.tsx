import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ServiceManifestEntry } from '@/shared/api/types'
import type { RunBootFailure } from '@shared/run-state'
import { BootFailureDialog } from './BootFailureDialog'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const service = { name: 'api', safeName: 'api', command: 'npm run dev', cwd: '/wt/api' } as ServiceManifestEntry

const compilerExcerpt = [1, 2, 3, 4, 5].map((n) => `ERROR in ./src/f${n}.ts:${n}:1\nTS2322: Message ${n} is long enough to clamp on the card.`).join('\n\n')

function render(failure: Partial<RunBootFailure>, onClose = () => {}, open = true) {
  act(() => root.render(
    <BootFailureDialog
      open={open}
      onClose={onClose}
      service={service}
      failure={{ service: 'api', safeName: 'api', reason: 'health-timeout', detail: 'Timed out after 60s.', logPath: '/runs/r1/svc-api.log', ...failure }}
    />,
  ))
}

function dialog(): HTMLElement | null {
  return document.querySelector('[data-testid="boot-failure-dialog"]')
}

/** Section headings, then the diagnostic terms under them. */
function rubrics(): string[] {
  return [...dialog()!.querySelectorAll('.cl-rubric, dt')].map((node) => node.textContent ?? '')
}

describe('BootFailureDialog', () => {
  it('lists every compiler error in full over the diagnostics and raw output', () => {
    render({ classification: 'compiler-failure', excerpt: compilerExcerpt, excerptTruncated: true, command: service.command, cwd: service.cwd })

    expect(dialog()!.textContent).toContain('Boot failure · api')
    expect(dialog()!.textContent).toContain('Service build failed before it became ready.')
    expect(dialog()!.querySelectorAll('li')).toHaveLength(5)
    expect(dialog()!.querySelector('.line-clamp-2')).toBeNull()
    // Same command and directory as the card, and no captured process: nothing to add.
    expect(rubrics()).toEqual(['Compiler errors · 5', 'Diagnostics', 'Detail', 'Evidence', 'Preserved output'])
    expect(dialog()!.textContent).toContain('excerpt truncated; open the service log')
    expect([...dialog()!.querySelectorAll('button')].map((button) => button.textContent)).not.toContain('Open service log')
    // The body keeps the Modal's own scroller, so a long list scrolls instead of clipping.
    expect(dialog()!.querySelector('li')!.closest('.overflow-y-auto')).not.toBeNull()
  })

  it('shows the process and the command and directory Canary really used when they differ', () => {
    render({ reason: 'process-exited', exitCode: 1, command: 'sh -c wrapper', cwd: '/wt/other', excerpt: 'Error: boom' })

    expect(rubrics()).toEqual(['Diagnostics', 'Detail', 'Process', 'Command', 'Directory', 'Preserved output'])
    expect(dialog()!.textContent).toContain('exit 1')
    expect(dialog()!.textContent).toContain('sh -c wrapper')
    expect(dialog()!.textContent).not.toContain('excerpt truncated')
  })

  it('renders only diagnostics when nothing was preserved, and closes', () => {
    const onClose = vi.fn()
    render({}, onClose)

    expect(rubrics()).toEqual(['Diagnostics', 'Detail'])
    act(() => (dialog()!.querySelector('button[aria-label="Close"]') as HTMLButtonElement).click())
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('renders nothing while closed', () => {
    render({}, () => {}, false)
    expect(dialog()).toBeNull()
  })
})
