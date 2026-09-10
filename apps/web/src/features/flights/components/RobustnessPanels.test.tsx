// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RobustnessFinding, RobustnessJobManifest } from '@shared/robustness/jobs'
import { ROBUSTNESS_ENVELOPE_FORMAT } from '@shared/robustness/types'
import { RobustnessFindingsPanel, RobustnessMatrixPanel, envelopeAtoms, findingStatusLabel, robustnessFindingKey } from './RobustnessPanels'

// The matrix's job is to say WHICH cell broke — a clean cell leaves no record,
// so the pane has to draw the absence honestly (pending while running, held
// once done) and state the clean count in words. The finding card's job is the
// action: the smallest envelope that still fails, and one button that sends it
// to a run the repair agent can work on.

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const ENVELOPE = {
  format: ROBUSTNESS_ENVELOPE_FORMAT,
  latency: { ms: 250 },
  duplicate: { gapMs: 40, match: 'POST /api/**' },
  restart: [{ slot: 'API_PORT', afterNth: 2, match: 'POST /api/**' }],
}

function finding(over: Partial<RobustnessFinding> = {}): RobustnessFinding {
  return {
    cell: { specFile: 'e2e/checkout.spec.ts', atom: 'latency' },
    failedTests: ['pays with a saved card', 'shows the receipt'],
    runId: 'run-cell-1',
    requirements: ['@req-pay-1'],
    status: 'confirmed',
    envelope: { format: ROBUSTNESS_ENVELOPE_FORMAT, latency: { ms: 250 } },
    shrink: {
      status: 'confirmed',
      envelope: { format: ROBUSTNESS_ENVELOPE_FORMAT, latency: { ms: 125 } },
      probes: 3,
      budgetExhausted: false,
      confirmations: { asked: 3, reproduced: 3 },
      steps: [
        { probe: 0, envelope: { format: ROBUSTNESS_ENVELOPE_FORMAT, latency: { ms: 250 } }, reproduced: true, why: 'does the full envelope reproduce' },
        { probe: 1, envelope: { format: ROBUSTNESS_ENVELOPE_FORMAT, latency: { ms: 125 } }, reproduced: true, why: 'halve the latency' },
        { probe: 2, envelope: { format: ROBUSTNESS_ENVELOPE_FORMAT, latency: { ms: 62 } }, reproduced: false, why: 'halve it again' },
      ],
      repro: 'latency 125 ms',
    },
    repro: 'latency 125 ms',
    ...over,
  }
}

function job(over: Partial<RobustnessJobManifest> = {}): RobustnessJobManifest {
  return {
    jobId: 'rj-1',
    feature: 'checkout',
    runId: 'run-9',
    envelope: ENVELOPE,
    status: 'done',
    startedAt: '2026-09-10T00:00:00Z',
    endedAt: '2026-09-10T00:20:00Z',
    cells: { planned: 6, done: 6 },
    findings: [],
    skipped: [],
    log: '',
    ...over,
  }
}

async function render(node: React.ReactNode) {
  await act(async () => { root.render(node) })
}

const q = <T extends Element = HTMLElement>(sel: string) => container.querySelector<T>(sel)
const qa = (sel: string) => [...container.querySelectorAll<HTMLElement>(sel)]

describe('envelopeAtoms / findingStatusLabel / robustnessFindingKey', () => {
  it('lists only the atoms an envelope declares, in column order; an empty restart list is no column', () => {
    expect(envelopeAtoms(ENVELOPE)).toEqual(['latency', 'duplicate', 'restart'])
    expect(envelopeAtoms({ format: ROBUSTNESS_ENVELOPE_FORMAT, restart: [] })).toEqual([])
    expect(envelopeAtoms({ format: ROBUSTNESS_ENVELOPE_FORMAT, duplicate: { gapMs: 1, match: 'POST /x' } })).toEqual(['duplicate'])
  })

  it('reads the confirmation tally off the shrink result and states the default bar when none has run', () => {
    expect(findingStatusLabel(finding())).toBe('confirmed 3/3')
    expect(findingStatusLabel(finding({ status: 'unconfirmed', shrink: { ...finding().shrink!, status: 'unconfirmed', confirmations: { asked: 3, reproduced: 1 } } }))).toBe('unconfirmed — reproduced 1/3')
    expect(findingStatusLabel(finding({ status: 'confirmed', shrink: undefined }))).toBe('confirmed 3/3')
    expect(findingStatusLabel(finding({ status: 'unconfirmed', shrink: undefined }))).toBe('unconfirmed — reproduced 0/3')
    expect(findingStatusLabel(finding({ status: 'found' }))).toBe('found — shrink queued')
    expect(findingStatusLabel(finding({ status: 'shrinking' }))).toBe('shrinking…')
    expect(robustnessFindingKey(finding())).toBe('e2e/checkout.spec.ts latency')
  })
})

describe('RobustnessMatrixPanel', () => {
  it('holds a row-list skeleton while awaited and renders nothing once settled with no job', async () => {
    await render(<RobustnessMatrixPanel job={null} awaiting="live" />)
    expect(q('[data-testid="robustness-matrix-skeleton"]')?.textContent).toContain('Perturbation matrix')
    await render(<RobustnessMatrixPanel job={null} />)
    expect(container.textContent).toBe('')
  })

  it('a clean, complete matrix has no rows to draw — it says so and states the held count in words', async () => {
    await render(<RobustnessMatrixPanel job={job()} />)
    expect(q('[data-testid="robustness-matrix-empty"]')?.textContent).toBe('No cell failed or was skipped.')
    expect(q('[data-testid="robustness-matrix-footer"]')?.textContent).toBe('6 of 6 cells held — a clean cell leaves no record')
    expect(q('[data-testid="robustness-matrix"]')?.textContent).toContain('Latency · Duplicate · Restart')
    expect(q('[data-testid="robustness-skipped"]')).toBeNull()
  })

  it('rows are the files with a record; a cell with none is held once done and pending while running', async () => {
    const skipped = { cell: { specFile: 'e2e/admin.spec.ts', atom: 'restart' as const }, reason: 'API_PORT never came back', runId: 'run-cell-3' }
    await render(<RobustnessMatrixPanel job={job({ findings: [finding()], skipped: [skipped], cells: { planned: 6, done: 6 } })} />)
    const rows = qa('[data-testid="robustness-matrix-row"]')
    expect(rows.map((r) => r.querySelector('[title]')?.getAttribute('title'))).toEqual(['e2e/admin.spec.ts', 'e2e/checkout.spec.ts'])
    const states = (row: HTMLElement) => [...row.querySelectorAll('[data-state]')].map((c) => c.getAttribute('data-state'))
    expect(states(rows[1])).toEqual(['failed', 'yes', 'yes'])
    expect(states(rows[0])).toEqual(['yes', 'yes', 'skipped'])
    expect(rows[1].querySelector('[data-testid="robustness-cell-latency"]')?.getAttribute('title')).toBe('2 tests failed · confirmed 3/3')
    expect(rows[0].querySelector('[data-testid="robustness-cell-restart"]')?.getAttribute('title')).toBe('not judged — API_PORT never came back')
    expect(rows[0].querySelector('[data-testid="robustness-cell-latency"]')?.getAttribute('title')).toBe('held')
    expect(q('[data-testid="robustness-skipped"]')?.textContent).toContain('e2e/admin.spec.ts · Restart — not judged: API_PORT never came back')
    // 6 done, 1 finding, 1 skipped: four held.
    expect(q('[data-testid="robustness-matrix-footer"]')?.textContent).toBe('4 of 6 cells held — a clean cell leaves no record')

    await render(<RobustnessMatrixPanel job={job({ status: 'running', findings: [finding()], cells: { planned: 6, done: 2 } })} />)
    expect(states(qa('[data-testid="robustness-matrix-row"]')[0])).toEqual(['failed', 'pending', 'pending'])
    expect(q('[data-testid="robustness-cell-duplicate"]')?.getAttribute('title')).toBe('not run yet, or held')
    expect(q('[data-testid="robustness-matrix-footer"]')?.textContent).toBe('2 of 6 cells run so far')
  })

  it('a running matrix with nothing recorded yet says "so far" rather than declaring the suite clean', async () => {
    await render(<RobustnessMatrixPanel job={job({ status: 'running', cells: { planned: 6, done: 1 } })} />)
    expect(q('[data-testid="robustness-matrix-empty"]')?.textContent).toBe('No cell has failed or been skipped so far.')
    expect(q('[data-testid="robustness-matrix-footer"]')?.textContent).toBe('1 of 6 cells run so far')
  })
})

describe('RobustnessFindingsPanel', () => {
  it('skeleton while awaited, nothing without a job, nothing for a matrix with no findings', async () => {
    await render(<RobustnessFindingsPanel job={null} awaiting="live" />)
    expect(q('[data-testid="robustness-findings-skeleton"]')?.textContent).toContain('Findings')
    await render(<RobustnessFindingsPanel job={null} />)
    expect(container.textContent).toBe('')
    await render(<RobustnessFindingsPanel job={job()} />)
    expect(container.textContent).toBe('')
  })

  it('one danger card per finding: the tests, the requirement tags, the shrunk repro line, and the action', async () => {
    const onSend = vi.fn()
    await render(<RobustnessFindingsPanel job={job({ findings: [finding()] })} onSendToRepair={onSend} />)
    const card = q('[data-testid="robustness-finding"]')!
    expect(card.className).toContain('border-danger/45')
    expect(card.getAttribute('data-status')).toBe('confirmed')
    expect(card.textContent).toContain('e2e/checkout.spec.ts · Latency')
    expect(q('[data-testid="robustness-finding-status"]')?.textContent).toBe('confirmed 3/3')
    expect([...card.querySelectorAll('[data-testid="robustness-finding-tests"] li')].map((li) => li.textContent)).toEqual(['pays with a saved card', 'shows the receipt'])
    expect(q('[data-testid="robustness-finding-requirements"]')?.textContent).toBe('@req-pay-1')
    expect(card.textContent).toContain('Smallest envelope that still fails')
    expect(q('[data-testid="robustness-finding-repro"]')?.textContent).toBe('latency 125 ms')
    const button = q<HTMLButtonElement>('[data-testid="robustness-send-to-repair"]')!
    expect(button.textContent).toBe('Send to repair')
    expect(button.disabled).toBe(false)
    await act(async () => { button.click() })
    expect(onSend).toHaveBeenCalledWith(finding())
  })

  it('the button reads busy for the finding being sent and only that one', async () => {
    const other = finding({ cell: { specFile: 'e2e/admin.spec.ts', atom: 'duplicate' } })
    await render(<RobustnessFindingsPanel job={job({ findings: [finding(), other] })} onSendToRepair={vi.fn()} sending={robustnessFindingKey(other)} />)
    const buttons = qa('[data-testid="robustness-send-to-repair"]') as HTMLButtonElement[]
    expect(buttons.map((b) => [b.textContent, b.disabled])).toEqual([['Send to repair', false], ['Starting…', true]])
  })

  it('no action without a handler (read-only external flight) or before shrink has settled the envelope', async () => {
    await render(<RobustnessFindingsPanel job={job({ findings: [finding()] })} />)
    expect(q('[data-testid="robustness-send-to-repair"]')).toBeNull()
    expect(q('[data-testid="robustness-finding-requirements"]')).not.toBeNull()

    await render(<RobustnessFindingsPanel job={job({ findings: [finding({ status: 'shrinking', shrink: undefined, repro: undefined, requirements: [] })] })} onSendToRepair={vi.fn()} />)
    expect(q('[data-testid="robustness-send-to-repair"]')).toBeNull()
    expect(q('[data-testid="robustness-finding-requirements"]')).toBeNull()
    expect(container.textContent).toContain('Envelope it failed under')
    // No shrink yet: the line is derived from the cell's own envelope.
    expect(q('[data-testid="robustness-finding-repro"]')?.textContent).toBe('latency 250 ms')
    expect(q('[data-testid="robustness-trace-toggle"]')).toBeNull()
  })

  it('falls back to the shrink result\'s own repro line when the finding has not copied it yet', async () => {
    await render(<RobustnessFindingsPanel job={job({ findings: [finding({ repro: undefined })] })} />)
    expect(q('[data-testid="robustness-finding-repro"]')?.textContent).toBe('latency 125 ms')
  })

  it('the shrink trace is collapsed by default and lists every probe with what it asked and how it answered', async () => {
    await render(<RobustnessFindingsPanel job={job({ findings: [finding({ status: 'unconfirmed', shrink: { ...finding().shrink!, status: 'unconfirmed', budgetExhausted: true, confirmations: { asked: 3, reproduced: 2 } } })] })} />)
    expect(q('[data-testid="robustness-finding-status"]')?.textContent).toBe('unconfirmed — reproduced 2/3')
    expect(q('[data-testid="robustness-trace"]')).toBeNull()
    const toggle = q<HTMLButtonElement>('[data-testid="robustness-trace-toggle"]')!
    expect(toggle.textContent).toBe('Show shrink trace — 3 probes, budget exhausted')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    await act(async () => { toggle.click() })
    expect(toggle.textContent).toContain('Hide shrink trace')
    const rows = [...q('[data-testid="robustness-trace"]')!.querySelectorAll('li')]
    expect(rows.map((li) => li.textContent)).toEqual([
      'checkdoes the full envelope reproducereproduced',
      '#1halve the latencyreproduced',
      '#2halve it againheld',
    ])
    expect(rows[1].querySelector('[title]')?.getAttribute('title')).toBe('halve the latency — latency 125 ms')
    await act(async () => { toggle.click() })
    expect(q('[data-testid="robustness-trace"]')).toBeNull()
  })
})
