// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { PortifyManifest } from '@/shared/api/client'
import type { CoverageLedger, TestCoverage } from '@/shared/api/types'
import { BootCheckPanel, CoverageCompositionPanel, DoubleBootPanel, OverlayPanel } from './StageEvidencePanels'

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

  it('the awaited card is the same card minus its counts — every bucket named, a bar where each figure lands', async () => {
    // The placeholder has to be the HEIGHT of the card it becomes, which a
    // generic line-block is not: the Passes card below it moved 74px when the
    // ledger landed. Naming the buckets costs nothing — they are vocabulary,
    // not measurements — and it buys the exact geometry.
    await act(async () => { root.render(<CoverageCompositionPanel ledger={null} awaiting="live" />) })
    const card = container.querySelector('[data-testid="coverage-composition-skeleton"]')
    expect(card?.textContent).toContain('What the tests cover')
    // Both groups, in the settled order, without the population counts they
    // cannot yet know.
    expect(container.querySelector('[data-testid="composition-strength"]')?.textContent).toContain('Test depth')
    expect(card?.textContent).not.toContain('Test depth ·')
    expect(container.querySelector('[data-testid="composition-gaps"]')?.textContent).toContain('Requirement coverage')
    // Every bucket row of the settled card is present, and each carries a
    // placeholder rather than a zero — an unmeasured bucket must not read as a
    // measured empty one.
    expect(container.querySelectorAll('[data-testid^="composition-strength-"]')).toHaveLength(4)
    expect(container.querySelectorAll('[data-testid^="composition-gaps-"]')).toHaveLength(4)
    expect(container.querySelectorAll('[data-testid="skeleton-bar"]')).toHaveLength(8)
    expect(container.querySelector('[data-testid="composition-strength-strong"]')?.textContent).toBe('Strong')
  })

  it('renders nothing without a ledger, or for a suite with no requirements to compose', async () => {
    await render(null)
    expect(container.querySelector('[data-testid="coverage-composition"]')).toBeNull()
    await render(ledger({ tests: [spec({ strength: 'solid' })] }))
    expect(container.querySelector('[data-testid="coverage-composition"]')).toBeNull()
  })

  it('keeps the spec-depth group when no specs exist — both columns hold their width', async () => {
    // The group used to drop out, which halved the requirement column the moment
    // the first authored test arrived. All-zero is also the honest reading of a
    // suite with 4 untested requirements: no depth, not "no such measurement".
    await render(ledger({
      totals: { total: 4, covered: 0, pathIncomplete: 0, variantIncomplete: 0, untested: 4, orphanTests: 0 },
    }))
    expect(container.querySelector('[data-testid="composition-strength"]')?.textContent)
      .toContain('Test depth · 0 tests')
    expect(row('composition-strength', 'shallow')).toContain('Shallow0')
    expect(row('composition-strength', 'strong')).toContain('Strong0')
    expect(row('composition-gaps', 'untested')).toContain('Untested4')
  })
})

// The awaited half of the two row-list cards. Both settle into a list of
// single-line rows, and a placeholder row has no text node to set that line box —
// so without a shared height floor the card grows under the reader when the rows
// land. happy-dom does not lay out, so the floor is asserted as the CLASS both
// branches carry (measured at 30px in the browser), not as a computed height.
describe('row-list cards hold their row geometry while awaited', () => {
  const rowsOf = (testId: string) =>
    [...container.querySelectorAll(`[data-testid="${testId}"] li`)]

  it('BootCheckPanel: two rows of the settled height, each with the name and timing slots held', async () => {
    await act(async () => { root.render(<BootCheckPanel boot={null} awaiting="live" />) })
    const held = rowsOf('boot-check-skeleton')
    // Two rows is the SHAPE, not a prediction: nothing in the flight record holds
    // the service count until the boot run is read.
    expect(held).toHaveLength(2)
    for (const li of held) expect(li.className).toContain('min-h-[30px]')
    expect(held[0]?.querySelectorAll('[data-testid="skeleton-bar"]')).toHaveLength(2)
    expect(held[0]?.querySelector('[data-testid="skeleton-bead"]')).not.toBeNull()

    // The settled row carries the identical floor, which is why adding it changed
    // nothing for that row — the two cannot drift apart.
    await act(async () => {
      root.render(<BootCheckPanel boot={null} recorded={[{ name: 'web', status: 'stopped' }]} />)
    })
    const settled = rowsOf('boot-check-panel')
    expect(settled).toHaveLength(1)
    expect(settled[0]?.className).toContain('min-h-[30px]')
    expect(settled[0]?.textContent).toContain('web')
  })

  it('BootCheckPanel renders nothing once settled with no services — an empty card is not an empty promise', async () => {
    await act(async () => { root.render(<BootCheckPanel boot={null} />) })
    expect(container.querySelector('[data-testid="boot-check-skeleton"]')).toBeNull()
    expect(container.querySelector('[data-testid="boot-check-panel"]')).toBeNull()
  })

  it('DoubleBootPanel names both instances while awaited — the count and names are known before the ports', async () => {
    await act(async () => { root.render(<DoubleBootPanel portify={null} awaiting="live" />) })
    const held = rowsOf('double-boot-skeleton')
    expect(held).toHaveLength(2)
    // The real text is what gives the row its height, so no floor is needed here.
    expect(held[0]?.textContent).toContain('Copy A')
    expect(held[1]?.textContent).toContain('Copy B')
    expect(held[0]?.querySelector('[data-testid="skeleton-bar"]')).not.toBeNull()

    await act(async () => { root.render(<DoubleBootPanel portify={null} />) })
    expect(container.querySelector('[data-testid="double-boot-skeleton"]')).toBeNull()
  })
})
