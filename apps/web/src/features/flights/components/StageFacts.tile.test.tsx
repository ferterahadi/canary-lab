// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FACT_GLOSS, FACT_HELP, FactTile, type StageFact } from './StageFacts'
import type { AwaitingState } from '@/shared/ui/Skeleton'

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

function renderWith(fact: StageFact, awaiting: AwaitingState) {
  act(() => { root.render(<FactTile fact={fact} awaiting={awaiting} />) })
  return container.querySelector<HTMLDivElement>('[data-testid="fact-tile"]')!
}

function render(fact: StageFact) {
  act(() => { root.render(<FactTile fact={fact} />) })
  return container.querySelector<HTMLDivElement>('[data-testid="fact-tile"]')!
}

describe('FactPlaceholder — a bar is a promise, a dash is not (R86)', () => {
  const slot = (tile: HTMLElement) => tile.querySelector<HTMLElement>('[data-testid="fact-awaiting"]')!
  const fact: StageFact = { label: 'Requirements inferred', value: '', awaiting: true }

  it('gives only a live tile a bar', () => {
    expect(slot(renderWith(fact, 'live')).querySelector('[data-testid="skeleton-bar"]')).not.toBeNull()
  })

  it('shows a dash while parked, hued to say the slot is merely held open', () => {
    const held = slot(renderWith(fact, 'idle'))
    expect(held.querySelector('[data-testid="skeleton-bar"]')).toBeNull()
    expect(held.textContent).toBe('—')
    expect(held.querySelector<HTMLElement>('span')?.style.color).toBe('var(--text-muted)')
  })

  it('reddens the dash once the step failed, and says so to a screen reader', () => {
    const struck = slot(renderWith(fact, 'failed'))
    expect(struck.querySelector<HTMLElement>('span')?.style.color).toBe('var(--danger)')
    expect(struck.getAttribute('aria-label')).toBe('not measured — the step failed')
  })

  it('keeps the tile height the figure will need, in every state', () => {
    for (const awaiting of ['live', 'idle', 'failed'] as const) {
      expect(slot(renderWith(fact, awaiting)).className).toContain('h-[22px]')
    }
  })

  it('holds the meter slot only for a tile that settles WITH a meter', () => {
    // A tile grid row is as tall as its tallest tile, so one metered tile
    // settling used to grow every tile beside it by the bar's 11px.
    const metered = renderWith({ label: 'Requirements covered', value: '', awaiting: true, meter: true }, 'live')
    const track = metered.querySelector<HTMLElement>('[data-testid="fact-meter-track"]')
    expect(track).not.toBeNull()
    // The same geometry FactBar and FactSegments occupy — and an empty TRACK, not
    // a meter drawn at 0%, which would state a measurement nobody made.
    expect(track?.className).toContain('h-[3px]')
    expect(track?.className).toContain('mt-2')
    expect(track?.querySelector('div')).toBeNull()
    // A bare count settles without one, so reserving the slot there would leave
    // permanent dead space in the settled band.
    expect(renderWith(fact, 'live').querySelector('[data-testid="fact-meter-track"]')).toBeNull()
  })
})

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

  it('says what happened instead of the gloss once the step failed', () => {
    // The gloss describes a figure this tile is now never going to hold, so a
    // failed placeholder replaces it rather than promising the meaning of a
    // number that isn't coming.
    const tile = renderWith({ label: 'Services booted', value: '', awaiting: true }, 'failed')
    expect(subOf(tile)).toBe('not measured')
  })

  it('leaves an identity tile two lines — a gloss under a filename is noise', () => {
    const tile = render({ label: 'Archive', value: 'canary-shop-8vfg.zip', mono: true })
    expect(FACT_GLOSS['Archive']).toBeUndefined()
    expect(subOf(tile)).toBeUndefined()
    expect(tile.textContent).toContain('canary-shop-8vfg.zip')
  })
})
