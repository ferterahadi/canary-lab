// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { PortifyManifest } from '@/shared/api/client'
import { OverlayPanel } from './StageEvidencePanels'

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
      .toContain('Overlay · 4 files across 2 repos')
  })

  it('names no repo count when the diff carries no group headers', async () => {
    await render(['+++ b/build.gradle', '+canaryPort = 1'].join('\n'))
    const text = container.querySelector('[data-testid="overlay-panel"]')?.textContent
    expect(text).toContain('Overlay · 1 file')
    expect(text).not.toContain('across')
  })

  it('keeps the filename whole and dims only the directory — truncating the tail would hide which file it is', async () => {
    await render(TWO_REPOS)
    const rows = [...container.querySelectorAll('li')].map((li) => li.textContent ?? '')
    const deep = rows.find((r) => r.includes('AppConfig.java'))
    expect(deep).toContain('oms-service/src/main/java/sg/demo/configuration/')
    // The dimmed directory is the element allowed to truncate; the basename sits
    // in its own non-shrinking span.
    const base = [...container.querySelectorAll('span.shrink-0')].map((s) => s.textContent)
    expect(base).toContain('AppConfig.java')
  })

  it('still says what an overlay IS — the card must not read as edits landing in the product repos', async () => {
    await render(TWO_REPOS)
    expect(container.querySelector('[data-testid="overlay-panel"]')?.textContent)
      .toContain('Nothing lands in the product repos.')
  })
})
