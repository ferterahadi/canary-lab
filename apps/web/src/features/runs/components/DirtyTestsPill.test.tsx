// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DirtyTestsPill } from './DirtyTestsPill'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

function render(props: Partial<Parameters<typeof DirtyTestsPill>[0]> = {}) {
  const onOpen = vi.fn()
  act(() => {
    root.render(<DirtyTestsPill suites={1} weakerSuites={0} pendingSuites={0} onOpen={onOpen} {...props} />)
  })
  return { onOpen, button: container.querySelector('button') }
}

describe('DirtyTestsPill', () => {
  it('renders nothing when no suite changed', () => {
    render({ suites: 0 })
    expect(container.querySelector('button')).toBeNull()
  })

  it('reads a changed suite in a neutral tone — no danger, no "hint"', () => {
    const { button } = render({ suites: 2 })
    expect(button?.textContent).toContain('Tests changed')
    expect(button?.textContent).toContain('2')
    expect(button?.textContent).not.toContain('hint')
    // No emphasis: the button carries no inline danger colour.
    expect(button?.getAttribute('style') ?? '').not.toContain('--danger')
    expect(button?.getAttribute('aria-label')).toMatch(/2 suites with changed test files/)
  })

  it('names the suites whose live run is waiting on an adopt', () => {
    const { button } = render({ suites: 3, pendingSuites: 1 })
    expect(button?.textContent).toContain('1 awaiting adopt')
    expect(button?.getAttribute('title')).toMatch(/1 suite has edits a live run has not executed — adopt or restore/)
  })

  it('turns danger only for a weaker reading, labels it a hint, and counts the weakened suites', () => {
    const { button } = render({ suites: 3, weakerSuites: 1 })
    expect(button?.textContent).toContain('Tests weakened')
    expect(button?.textContent).toContain('hint')
    expect(button?.getAttribute('style')).toContain('--danger')
    // The badge shows the weakened count (1), not every changed suite (3).
    expect(button?.querySelector('.rounded-full.px-1')?.textContent).toBe('1')
    expect(button?.getAttribute('title')).toMatch(/^Hint:.*false positive 2\.4%.*no human/)
  })

  it('opens the review on click', () => {
    const { onOpen, button } = render()
    act(() => { button?.click() })
    expect(onOpen).toHaveBeenCalledTimes(1)
  })
})
