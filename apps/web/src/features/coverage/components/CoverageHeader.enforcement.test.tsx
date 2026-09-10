// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CoverageLedger } from '@/shared/api/types'
import { CoverageHeader } from './CoverageHeader'
import { LEDGER } from './__fixtures__/CoverageLedgerPage.part2-fixtures'

// The header's plain-language ratios gain the time axis roll-up (D11):
// "n/N proven in run <id>" beside covered and mapped.

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

function render(ledger: CoverageLedger): void {
  act(() => {
    root.render(<CoverageHeader ledger={ledger} gapFilter={null} onToggleGap={() => {}} strengthFilter={null} onToggleStrength={() => {}} follow={false} onToggleFollow={() => {}} />)
  })
}

describe('CoverageHeader — proven in run', () => {
  it('states how many requirements are proven unchanged, and by which run', () => {
    const led = structuredClone(LEDGER)
    led.enforcement = { runId: 'run-9', provenUnchanged: 1, total: 3, states: { 'proven-unchanged': 1, 'tests-weakened': 0, 'wording-ahead': 1, 'proof-stale': 1 } }
    render(led)
    const stat = container.querySelector('[data-testid="proven-stat"]')
    expect(stat?.textContent).toContain('1/3 proven in run run-9')
  })

  it('a feature with no run yet says so rather than inventing a run', () => {
    const led = structuredClone(LEDGER)
    led.enforcement = { provenUnchanged: 0, total: 3, states: { 'proven-unchanged': 0, 'tests-weakened': 0, 'wording-ahead': 3, 'proof-stale': 0 } }
    render(led)
    expect(container.querySelector('[data-testid="proven-stat"]')?.textContent).toContain('0/3 proven · no run yet')
  })

  it('an older server without the axis shows no proven stat', () => {
    const led = structuredClone(LEDGER)
    delete led.enforcement
    render(led)
    expect(container.querySelector('[data-testid="proven-stat"]')).toBeNull()
  })
})
