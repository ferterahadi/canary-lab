// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunDetail } from '@shared/run-detail'
import type { RunIndexEntry } from '@shared/run-index'
import { RunRow } from './RunRow'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const run: RunIndexEntry = { runId: 'run-z6kc', feature: 'checkout', startedAt: '2026-05-31T10:00:00.000Z', status: 'failed' }
const detail = {
  runId: 'run-z6kc',
  manifest: { services: [{ allocatedPorts: { api: 4123 } }] },
  summary: { total: 12, passed: 9, failed: [] },
} as unknown as RunDetail

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
  vi.clearAllMocks()
})

function renderRow(props: Partial<Parameters<typeof RunRow>[0]> = {}): void {
  act(() => {
    root.render(<ul><RunRow run={run} detail={detail} onSelect={() => {}} {...props} /></ul>)
  })
}

describe('RunRow (R80 hero props)', () => {
  it('default: shows the feature, ports, and the pass count inline', () => {
    renderRow()
    const text = container.textContent ?? ''
    expect(text).toContain('checkout')
    expect(text).toContain(':4123')
    expect(text).toContain('9/12 passed')
  })

  it('primaryLabel overrides the identity line', () => {
    renderRow({ primaryLabel: 'Run z6kc' })
    expect(container.textContent).toContain('Run z6kc')
    // The feature name is no longer the bold identity line.
    expect(container.querySelector('span[style*="font-weight: 500"]')?.textContent).toBe('Run z6kc')
  })

  it('names the envset beside the timestamp, and omits it when the run has none', () => {
    // Previous runs of one suite stack in the flight run stage. Spec selection
    // cannot vary by envset, so those rows declare the same roster and differ
    // only in what the environment let execute — the envset is what tells
    // "41/45 passed" apart from "4/45 passed" one row below.
    renderRow({ run: { ...run, env: 'meta' } })
    expect(container.textContent).toContain('meta')

    renderRow()
    expect(container.textContent).not.toContain('meta')
  })

  it('showPorts=false hides the allocated-ports segment', () => {
    renderRow({ showPorts: false })
    expect(container.textContent).not.toContain(':4123')
  })

  it("dot='live' drops a finished run's dot and its lane, so the title sits flush", () => {
    renderRow({ dot: 'live' })
    expect(container.querySelector('button .cl-status-dot')).toBeNull()
    // The chip still names the outcome — the dot was only repeating it.
    expect(container.textContent).toContain('Failed')
  })

  it("dot='live' keeps the status dot while the run is still going", () => {
    renderRow({ dot: 'live', run: { ...run, status: 'healing' } })
    expect(container.querySelector('button .cl-status-dot')).not.toBeNull()
  })

  it('showDuration appends a finished run\'s duration, and says nothing for a live one', () => {
    renderRow({ showDuration: true, run: { ...run, endedAt: '2026-05-31T10:18:02.000Z' } })
    expect(container.textContent).toContain('18m 2s')
    renderRow({ showDuration: true, run: { ...run, status: 'running' } })
    expect(container.textContent).not.toMatch(/\dm \d+s/)
  })

  it('showRepairs appends the repair cycles a run used, and nothing for a clean run', () => {
    renderRow({ showRepairs: true, run: { ...run, healCycles: 1 } })
    expect(container.textContent).toContain('1 repair')
    renderRow({ showRepairs: true, run: { ...run, healCycles: 10 } })
    expect(container.textContent).toContain('10 repairs')
    renderRow({ showRepairs: true })
    expect(container.textContent).not.toContain('repair')
  })

  it("stamp='day' adds the day to a run from another day", () => {
    renderRow({ stamp: 'day' })
    expect(container.textContent).not.toContain('Today')
    expect(container.textContent).toMatch(/May/)
  })

  it("passCount 'promoted' lifts the pass count out of the meta line", () => {
    renderRow({ passCount: 'promoted' })
    // Still shown once, as its own promoted segment.
    expect(container.textContent).toContain('9/12 passed')
    const occurrences = (container.textContent?.match(/9\/12 passed/g) ?? []).length
    expect(occurrences).toBe(1)
  })

  it('qualifies the status with a quiet "N pending" chip when the run holds unexecuted spec edits (D9)', () => {
    renderRow({ run: { ...run, status: 'healing', pendingSpecEdits: 2 } })
    const chip = container.querySelector('[data-testid="run-pending-edits"]')
    expect(chip?.textContent).toBe('2 pending')
    expect(chip?.getAttribute('title')).toMatch(/2 test-file changes .* not run. This run result is based on the recorded tests/)
    // Provenance, not an alarm: no danger hue on the companion chip.
    expect(chip?.getAttribute('style') ?? '').not.toContain('--danger')
    // The status chip itself is untouched.
    expect(container.textContent).toContain('Healing')
  })

  it('shows no pending chip when the run has none (and on runs recorded before the boundary)', () => {
    renderRow({ run: { ...run, pendingSpecEdits: 0 } })
    expect(container.querySelector('[data-testid="run-pending-edits"]')).toBeNull()
    renderRow()
    expect(container.querySelector('[data-testid="run-pending-edits"]')).toBeNull()
  })

  it('calls onSelect with the run when clicked', () => {
    const onSelect = vi.fn()
    renderRow({ onSelect })
    act(() => { container.querySelector('button')?.click() })
    expect(onSelect).toHaveBeenCalledWith(run)
  })
})

it.each(['passed', 'failed', 'aborted'] as const)('does not label historical changes as pending for a %s run', (status) => {
    renderRow({ run: { ...run, status, pendingSpecEdits: 2 } })
    expect(container.querySelector('[data-testid="run-pending-edits"]')).toBeNull()
    expect(container.textContent).toContain(status[0].toUpperCase() + status.slice(1))
  })
