import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunBootFailure } from '@shared/run-state'
import { compilerErrors } from '@/shared/ui/BootEvidence'
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

const excerpt = [
  ...[1, 2, 3, 4].map((n) => `ERROR in ./src/f${n}.ts:${n}:1\nTS2322: Message ${n} is long enough to clamp on the card.`),
  'ERROR in ./src/f5.ts:5:1\nModule not found',
].join('\n\n')

const failure: RunBootFailure = {
  service: 'api', safeName: 'api', reason: 'health-timeout', classification: 'compiler-failure',
  detail: 'Timed out after 60s.', logPath: '/runs/r1/svc-api.log', excerpt, excerptTruncated: true,
}

function render(onClose = () => {}, open = true) {
  act(() => root.render(<BootFailureDialog open={open} onClose={onClose} failure={failure} errors={compilerErrors(excerpt)} />))
}

function dialog(): HTMLElement | null {
  return document.querySelector('[data-testid="boot-failure-dialog"]')
}

describe('BootFailureDialog', () => {
  it('lists every compiler error in full and nothing the service log already holds', () => {
    render()

    expect(dialog()!.textContent).toContain('Boot failure · api')
    expect(dialog()!.textContent).toContain('Service build failed before it became ready.')
    expect(dialog()!.querySelectorAll('li')).toHaveLength(5)
    expect(dialog()!.querySelector('.line-clamp-2')).toBeNull()
    // An error the compiler gave no code keeps the column with a dash.
    expect(dialog()!.querySelectorAll('li')[4].textContent).toBe('—src/f5.ts:5:1Module not found')
    expect([...dialog()!.querySelectorAll('.cl-rubric')].map((node) => node.textContent)).toEqual(['Compiler errors · 5'])
    expect(dialog()!.textContent).not.toContain('Timed out after 60s.')
    expect(dialog()!.querySelector('pre')).toBeNull()
    expect([...dialog()!.querySelectorAll('button')].map((button) => button.textContent)).not.toContain('Open service log')
    // The body keeps the Modal's own scroller, so a long list scrolls instead of clipping.
    expect(dialog()!.querySelector('li')!.closest('.overflow-y-auto')).not.toBeNull()
  })

  it('closes, and renders nothing while closed', () => {
    const onClose = vi.fn()
    render(onClose)
    act(() => (dialog()!.querySelector('button[aria-label="Close"]') as HTMLButtonElement).click())
    expect(onClose).toHaveBeenCalledOnce()

    render(() => {}, false)
    expect(dialog()).toBeNull()
  })
})
