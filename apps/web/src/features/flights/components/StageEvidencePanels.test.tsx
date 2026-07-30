// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { PortifyManifest } from '@/shared/api/client'
import type { CoverageLedger, TestCoverage } from '@/shared/api/types'
import { CoverageCompositionPanel, OverlayPanel } from './StageEvidencePanels'

// The overlay card's job is ATTRIBUTION. Its paths are repo-relative, so a
// two-repo stack that gained a port-injection line in each `build.gradle` used to
// render two rows reading `build.gradle +8` with nothing to tell them apart —
// there was no way to answer "which app did canary edit?" from the card.

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

function manifest(diff: string): PortifyManifest {
  return { diff } as PortifyManifest
}

const TWO_REPOS = [
  '# repo: shop-api',
  '+++ b/build.gradle',
  '+canaryPort = System.getenv("PORT")',
  '+++ b/.gitignore',
  '+.gradle-canary-*',
  '',
  '# repo: oms',
  '+++ b/oms-service/src/main/java/sg/demo/configuration/AppConfig.java',
  '+  int port = Integer.parseInt(System.getenv("PORT"));',
  '+++ b/build.gradle',
  '+canaryPort = System.getenv("PORT")',
].join('\n')

async function render(diff: string) {
  await act(async () => { root.render(<OverlayPanel portify={manifest(diff)} />) })
}

describe('OverlayPanel', () => {
  it('heads each repo group so two same-named files are attributable', async () => {
    await render(TWO_REPOS)
    expect(container.querySelector('[data-testid="overlay-group-shop-api"]')?.textContent).toBe('shop-api')
    expect(container.querySelector('[data-testid="overlay-group-oms"]')?.textContent).toBe('oms')
  })

  it('counts the repos in the kicker so the header matches what the body shows', async () => {
    await render(TWO_REPOS)
    expect(container.querySelector('[data-testid="overlay-panel"]')?.textContent)
      .toContain('Port changes · 4 files across 2 repos')
  })

  it('names no repo count when the diff carries no group headers', async () => {
    await render(['+++ b/build.gradle', '+canaryPort = 1'].join('\n'))
    const text = container.querySelector('[data-testid="overlay-panel"]')?.textContent
    expect(text).toContain('Port changes · 1 file')
    expect(text).not.toContain('across')
  })

  it('shows the filename alone and hides the directory behind the row tooltip', async () => {
    await render(TWO_REPOS)
    const rows = [...container.querySelectorAll('li')].map((li) => li.textContent ?? '')
    const deep = rows.find((r) => r.includes('AppConfig.java'))
    expect(deep).not.toContain('oms-service/src/main/java/sg/demo/configuration/')
    const path = [...container.querySelectorAll('span[title]')]
      .find((s) => s.textContent?.includes('AppConfig.java'))
    expect(path?.getAttribute('title')).toBe('oms-service/src/main/java/sg/demo/configuration/AppConfig.java')
  })

  it('marks an elided path as hoverable — a tooltip nobody knows about is a hidden path', async () => {
    await render(TWO_REPOS)
    const deep = [...container.querySelectorAll('span[title]')]
      .find((s) => s.textContent?.includes('AppConfig.java'))
    expect(deep?.querySelector('[data-testid="overlay-path-elision"]')?.textContent).toBe('…/')
    expect(deep?.className).toContain('cursor-help')
    expect(deep?.querySelector('span:last-child')?.className).toContain('decoration-dotted')
  })

  it('leaves a root-level file unmarked — there is no directory to reveal', async () => {
    await render(TWO_REPOS)
    const root = [...container.querySelectorAll('span[title]')]
      .find((s) => s.getAttribute('title') === '.gitignore')
    expect(root?.textContent).toBe('.gitignore')
    expect(root?.className).not.toContain('cursor-help')
    expect(root?.querySelector('span')?.className).not.toContain('underline')
  })

  it('still says what an overlay IS — the card must not read as edits landing in the product repos', async () => {
    await render(TWO_REPOS)
    expect(container.querySelector('[data-testid="overlay-panel"]')?.textContent)
      .toContain('nothing lands in the product repos.')
  })
})

// The composition card is where the two distributions live now that the band is
// three bare counts. Its labels and hues are the coverage feature's own
// (GAP_META / STRENGTH_META), so a user crossing to the ledger page the stage
// header links to reads the identical vocabulary.

function spec(over: Partial<TestCoverage>): TestCoverage {
  return { name: 't', requirements: ['R1'], pathTypes: ['happy'], ...over }
}

function ledger(over: Partial<CoverageLedger> = {}): CoverageLedger {
  return {
    feature: 'checkout',
    requirements: [],
    tests: [],
    totals: { total: 0, covered: 0, pathIncomplete: 0, variantIncomplete: 0, untested: 0, orphanTests: 0 },
    coveragePct: 0,
    mappedPct: 0,
    orphanRequirementIds: [],
    orphanTestNames: [],
    ...over,
  }
}

const MIXED = ledger({
  totals: { total: 10, covered: 6, pathIncomplete: 2, variantIncomplete: 1, untested: 1, orphanTests: 0 },
  tests: [
    spec({ name: 'a', strength: 'strong' }),
    spec({ name: 'b', strength: 'solid' }),
    spec({ name: 'c', strength: 'solid' }),
    spec({ name: 'd', strength: 'shallow' }),
  ],
})

describe('CoverageCompositionPanel', () => {
  async function render(l: CoverageLedger | null) {
    await act(async () => { root.render(<CoverageCompositionPanel ledger={l} />) })
  }

  const row = (group: string, key: string) =>
    container.querySelector(`[data-testid="${group}-${key}"]`)?.textContent

  it('counts every strength bucket, worst-first, in the coverage feature\'s own labels', async () => {
    await render(MIXED)
    const group = container.querySelector('[data-testid="composition-strength"]')
    expect(group?.textContent).toContain('Test depth · 4 tests')
    expect(row('composition-strength', 'shallow')).toContain('Shallow1')
    expect(row('composition-strength', 'solid')).toContain('Solid2')
    expect(row('composition-strength', 'strong')).toContain('Strong1')
  })

  it('names each gap KIND separately — path and variant gaps decide different next tests', async () => {
    await render(MIXED)
    expect(container.querySelector('[data-testid="composition-gaps"]')?.textContent)
      .toContain('Requirement coverage · 10 requirements')
    expect(row('composition-gaps', 'covered')).toContain('Covered6')
    expect(row('composition-gaps', 'path-incomplete')).toContain('Path gap2')
    expect(row('composition-gaps', 'variant-incomplete')).toContain('Variant gap1')
    expect(row('composition-gaps', 'untested')).toContain('Untested1')
  })

  it('renders EMPTY buckets rather than dropping them — "0 strong" is the finding on a shallow suite', async () => {
    await render(ledger({
      totals: { total: 1, covered: 1, pathIncomplete: 0, variantIncomplete: 0, untested: 0, orphanTests: 0 },
      tests: [spec({ strength: 'shallow' })],
    }))
    expect(row('composition-strength', 'strong')).toContain('Strong0')
    expect(row('composition-strength', 'basic')).toContain('Basic0')
    expect(row('composition-gaps', 'untested')).toContain('Untested0')
  })

  it('grades an ungraded spec as shallow, the way the ledger page does', async () => {
    await render(ledger({
      totals: { total: 1, covered: 1, pathIncomplete: 0, variantIncomplete: 0, untested: 0, orphanTests: 0 },
      tests: [spec({ strength: undefined })],
    }))
    expect(row('composition-strength', 'shallow')).toContain('Shallow1')
  })

  it('calls out orphan specs, which no tile reports any more', async () => {
    await render(ledger({
      totals: { total: 2, covered: 2, pathIncomplete: 0, variantIncomplete: 0, untested: 0, orphanTests: 3 },
      tests: [spec({ strength: 'solid' })],
    }))
    expect(container.querySelector('[data-testid="composition-orphans"]')?.textContent)
      .toContain('3 tests match no requirement')
  })

  it('renders nothing without a ledger, or for a suite with no requirements to compose', async () => {
    await render(null)
    expect(container.querySelector('[data-testid="coverage-composition"]')).toBeNull()
    await render(ledger({ tests: [spec({ strength: 'solid' })] }))
    expect(container.querySelector('[data-testid="coverage-composition"]')).toBeNull()
  })

  it('drops the spec-depth group when no specs exist, keeping the requirement group', async () => {
    await render(ledger({
      totals: { total: 4, covered: 0, pathIncomplete: 0, variantIncomplete: 0, untested: 4, orphanTests: 0 },
    }))
    expect(container.querySelector('[data-testid="composition-strength"]')).toBeNull()
    expect(row('composition-gaps', 'untested')).toContain('Untested4')
  })
})
