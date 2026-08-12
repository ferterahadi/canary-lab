// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StageActivity } from './StageActivity'

// The stop control on the activity band. It lives here rather than in the stage
// header because it acts on THIS transcript — the header's Pause stops the whole
// flight, and the two must not read as the same button.

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

function render(props: Parameters<typeof StageActivity>[0]): void {
  act(() => root.render(<StageActivity {...props} />))
}

const base = {
  sourceKey: 'k',
  live: true,
  settled: false,
  log: '[scout@2026-01-01T00:00:00Z] reading the repo…\n',
}

describe('StageActivity — stopping one agent', () => {
  it('shows no stop control when the band has no live agent to stop', () => {
    render({ ...base })
    expect(host.querySelector('[data-testid="stage-agent-stop"]')).toBeNull()
  })

  it('offers the stop when a live agent is passed, and calls back once', () => {
    const onStop = vi.fn()
    render({ ...base, agentStop: { label: '⏹ Stop agent', onStop } })
    const btn = host.querySelector('[data-testid="stage-agent-stop"]') as HTMLButtonElement
    expect(btn).not.toBeNull()
    expect(btn.textContent).toContain('Stop agent')
    // The consequence is in the tooltip, because the button cannot say it: the
    // step fails and the flight parks, but the run and export stay up.
    expect(btn.getAttribute('title')).toContain('will fail')
    expect(btn.getAttribute('title')).toContain('left alone')
    act(() => btn.click())
    expect(onStop).toHaveBeenCalledTimes(1)
  })

  it('does not collapse the rail the user is watching when the stop is clicked', () => {
    // The stop sits OUTSIDE the disclosure button; nesting it would make every
    // click also hide the transcript being stopped.
    const onStop = vi.fn()
    render({ ...base, agentStop: { label: '⏹ Stop agent', onStop } })
    const toggle = host.querySelector('[data-testid="stage-details-toggle"]') as HTMLButtonElement
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    act(() => (host.querySelector('[data-testid="stage-agent-stop"]') as HTMLButtonElement).click())
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
  })

  it('reports itself busy and refuses a second click while stopping', () => {
    const onStop = vi.fn()
    render({ ...base, agentStop: { label: '⏹ Stop agent', onStop, busy: true } })
    const btn = host.querySelector('[data-testid="stage-agent-stop"]') as HTMLButtonElement
    expect(btn.textContent).toContain('Stopping…')
    expect(btn.disabled).toBe(true)
  })
})
