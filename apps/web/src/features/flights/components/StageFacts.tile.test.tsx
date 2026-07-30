// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FACT_GLOSS, FACT_HELP, FactTile, type StageFact } from './StageFacts'

// The three lines every tile owes: label (+ the `?` that says an explanation
// exists), value, and a second line that is never blank. The band used to drop
// that second line exactly when the news was clean — a green run history showed
// two bare numbers — so these pin the fallback, not just the happy path.

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

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
  document.body.querySelector('[role="tooltip"]')?.remove()
})

function render(fact: StageFact) {
  act(() => { root.render(<FactTile fact={fact} />) })
  return container.querySelector<HTMLDivElement>('[data-testid="fact-tile"]')!
}

describe('FactTile explanations', () => {
  it('marks a tile that has an explanation and shows it on hovering the TILE, not just the mark', () => {
    const tile = render({ label: 'Port slots drafted', value: '2', big: true })
    // The mark is decorative — it advertises the tooltip, it is not the target.
    expect(tile.textContent).toContain('?')

    act(() => { tile.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
    expect(document.body.querySelector('[role="tooltip"]')?.textContent).toBe(FACT_HELP['Port slots drafted'])

    act(() => { tile.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })) })
    expect(document.body.querySelector('[role="tooltip"]')).toBeNull()
  })

  it('carries the explanation for a screen reader, which cannot hover', () => {
    const tile = render({ label: 'Requirements proven', value: '0/6', big: true })
    expect(tile.querySelector('.sr-only')?.textContent).toBe(FACT_HELP['Requirements proven'])
  })

  it('renders no mark and no tooltip for a label nothing explains — a `?` with nothing behind it is worse than none', () => {
    const tile = render({ label: 'Unexplained', value: 'x' })
    expect(tile.textContent).not.toContain('?')
    act(() => { tile.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
    expect(document.body.querySelector('[role="tooltip"]')).toBeNull()
  })
})

describe('FactTile second line', () => {
  // Read the line's own element, not the tile text: the gloss wording also
  // appears inside the sr-only explanation, so a substring match on the tile
  // would pass even with the line missing.
  const subOf = (tile: HTMLElement) => tile.querySelector('[data-testid="fact-sub"]')?.textContent

  it('falls back to the static gloss when the stage measured no breakdown', () => {
    expect(subOf(render({ label: 'Succeeded', value: '1', big: true }))).toBe(FACT_GLOSS['Succeeded'])
  })

  it('prefers the measured breakdown over the gloss', () => {
    expect(subOf(render({ label: 'Succeeded', value: '0', big: true, sub: '1 failed' }))).toBe('1 failed')
  })

  it('keeps the gloss on a placeholder, so nothing shifts when the figure lands', () => {
    const tile = render({ label: 'Services booted', value: '', awaiting: true })
    expect(tile.querySelector('[data-testid="fact-awaiting"]')).not.toBeNull()
    expect(subOf(tile)).toBe(FACT_GLOSS['Services booted'])
  })

  it('leaves an identity tile two lines — a gloss under a filename is noise', () => {
    const tile = render({ label: 'Archive', value: 'canary-shop-8vfg.zip', mono: true })
    expect(FACT_GLOSS['Archive']).toBeUndefined()
    expect(subOf(tile)).toBeUndefined()
    expect(tile.textContent).toContain('canary-shop-8vfg.zip')
  })
})
