// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExtractedTest } from '../api/types'
import { applyTheme } from '../lib/theme'
import { TestPresentation } from './TestPresentation'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('shiki/core', () => ({
  createHighlighterCore: async () => ({
    codeToHtml: (code: string, options: { theme: string }) => (
      `<pre class="shiki" data-shiki-theme="${options.theme}"><code>${code.split('\n').map((line) => `<span class="line">${line}</span>`).join('\n')}</code></pre>`
    ),
  }),
}))
vi.mock('shiki/engine/oniguruma', () => ({ createOnigurumaEngine: () => ({}) }))
vi.mock('shiki/langs/typescript.mjs', () => ({ default: {} }))
vi.mock('shiki/themes/one-dark-pro.mjs', () => ({ default: {} }))
vi.mock('shiki/themes/one-light.mjs', () => ({ default: {} }))
vi.mock('shiki/wasm', () => ({ default: {} }))

const TEST: ExtractedTest = {
  name: 'completes checkout',
  line: 7,
  bodyLine: 10,
  bodySource: "{\n  await page.goto('/checkout')\n}",
  steps: [],
  readable: {
    version: 2,
    title: 'completes checkout',
    completeness: 'partial',
    story: {
      steps: [
        {
          id: 'checkout-step',
          role: 'setup',
          text: 'Prepare checkout',
          spans: [{ text: 'Prepare checkout' }],
          fidelity: 'derived',
          source: {
            file: '/repo/e2e/checkout.spec.ts',
            startLine: 10,
            endLine: 12,
            snippet: "{\n  await page.goto('/checkout')\n}",
          },
        },
        {
          id: 'open-checkout',
          role: 'action',
          text: 'Open “/checkout”',
          spans: [{ text: 'Open “/checkout”' }],
          fidelity: 'derived',
          source: {
            file: '/repo/e2e/checkout.spec.ts',
            startLine: 11,
            endLine: 11,
            snippet: "await page.goto('/checkout')",
          },
        },
        {
          id: 'helper-check',
          role: 'check',
          text: 'Check that account is active',
          spans: [{ text: 'Check that ' }, { text: 'account', kind: 'variable' }, { text: ' is active' }],
          fidelity: 'derived',
          source: {
            file: '/repo/e2e/helpers/account.ts',
            startLine: 30,
            endLine: 30,
            snippet: 'expect(account.active).toBe(true)',
          },
        },
      ],
    },
    nodes: [
      {
        id: 'checkout-step',
        kind: 'group',
        text: 'Checkout',
        fidelity: 'exact',
        source: {
          file: '/repo/e2e/checkout.spec.ts',
          startLine: 10,
          endLine: 12,
          snippet: "{\n  await page.goto('/checkout')\n}",
        },
        children: [{
          id: 'open-checkout',
          kind: 'leaf',
          role: 'action',
          text: 'Open “/checkout”',
          fidelity: 'derived',
          source: {
            file: '/repo/e2e/checkout.spec.ts',
            startLine: 11,
            endLine: 11,
            snippet: "await page.goto('/checkout')",
          },
        }],
      },
      {
        id: 'helper-check',
        kind: 'leaf',
        role: 'unknown',
        text: 'Review this source step',
        fidelity: 'unresolved',
        source: {
          file: '/repo/e2e/helpers/account.ts',
          startLine: 30,
          endLine: 30,
          snippet: 'expect(account.active).toBe(true)',
        },
      },
    ],
  },
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  localStorage.clear()
  document.documentElement.classList.remove('dark')
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('TestPresentation', () => {
  it('opens in English and keeps the complete test source one action away', async () => {
    act(() => root.render(<TestPresentation test={TEST} sourceFile="/repo/e2e/checkout.spec.ts" />))

    expect(container.querySelector('[data-testid="test-presentation-english"]')).not.toBeNull()
    expect(container.textContent).toContain('Open “/checkout”')
    expect(container.textContent).toContain('Some syntax could not be translated')
    // The header names the same file:range in both modes, so switching feels
    // like changing the representation, not the component.
    expect(container.textContent).toContain('e2e/checkout.spec.ts:L10–12')
    expect(container.querySelector('[data-testid="test-presentation-code"]')).toBeNull()

    await act(async () => {
      ;(container.querySelector('[data-testid="test-presentation-code-tab"]') as HTMLButtonElement).click()
      await Promise.resolve()
    })

    expect(container.querySelector('[data-testid="test-presentation-code"]')).not.toBeNull()
    expect(container.textContent).toContain('e2e/checkout.spec.ts:L10–12')
    expect(container.textContent).toContain("await page.goto('/checkout')")
    const displayedLines = container.querySelectorAll<HTMLElement>('[data-code-line]')
    expect(displayedLines).toHaveLength(1)
    expect(displayedLines[0].dataset.codeLine).toBe('01')
    expect(displayedLines[0].textContent).toBe("await page.goto('/checkout')")
  })

  it('reveals a helper snippet in Code when its English node is selected', async () => {
    act(() => root.render(<TestPresentation test={TEST} sourceFile="/repo/e2e/checkout.spec.ts" />))

    await act(async () => {
      ;(container.querySelector('[data-testid="readable-story-item-helper-check"]') as HTMLButtonElement).click()
      await Promise.resolve()
    })

    expect(container.querySelector('[data-testid="test-presentation-code"]')).not.toBeNull()
    expect(container.textContent).toContain('helpers/account.ts:L30')
    expect(container.textContent).toContain('expect(account.active).toBe(true)')
    expect(container.textContent).toContain('Full test')
    expect(container.querySelectorAll('[data-selected-line="true"]')).toHaveLength(1)
  })

  it('highlights every line in an exact same-file source range', async () => {
    act(() => root.render(<TestPresentation test={TEST} sourceFile="/repo/e2e/checkout.spec.ts" />))

    await act(async () => {
      ;(container.querySelector('[data-testid="readable-story-item-checkout-step"]') as HTMLButtonElement).click()
      await Promise.resolve()
    })

    expect(container.textContent).toContain('e2e/checkout.spec.ts:L10–12')
    // Code mode omits the callback's standalone wrapper braces, leaving only
    // the executable source row while its file label keeps the full L10–12 range.
    expect(container.querySelectorAll('[data-selected-line="true"]')).toHaveLength(1)
    expect(container.textContent).toContain('Full test')
  })

  it('does not apply test-run highlights when helper source happens to equal the full body', async () => {
    const helperCollision: ExtractedTest = {
      ...TEST,
      readable: {
        ...TEST.readable,
        story: {
          steps: [{
            id: 'same-source-helper',
            role: 'action',
            text: 'Run matching helper',
            spans: [{ text: 'Run matching helper' }],
            fidelity: 'derived',
            source: {
              file: '/repo/e2e/helpers/matching.ts',
              startLine: 30,
              endLine: 32,
              snippet: TEST.bodySource,
            },
          }],
        },
        nodes: [{
          id: 'same-source-helper',
          kind: 'leaf',
          role: 'helper',
          text: 'Run matching helper',
          fidelity: 'derived',
          source: {
            file: '/repo/e2e/helpers/matching.ts',
            startLine: 30,
            endLine: 32,
            snippet: TEST.bodySource,
          },
        }],
      },
    }
    act(() => root.render(
      <TestPresentation
        test={helperCollision}
        sourceFile="/repo/e2e/checkout.spec.ts"
        activeLine={2}
        runningHighlight
        changedLines={new Set([2])}
      />,
    ))

    await act(async () => {
      ;(container.querySelector('[data-testid="readable-story-item-same-source-helper"]') as HTMLButtonElement).click()
      await Promise.resolve()
    })

    expect(container.textContent).toContain('helpers/matching.ts:L30–32')
    expect(container.querySelectorAll('[data-active-line="true"]')).toHaveLength(0)
    expect(container.querySelectorAll('[data-changed-line="true"]')).toHaveLength(0)
    expect(container.querySelectorAll('[data-selected-line="true"]')).toHaveLength(1)
  })

  it('keeps the Code view synchronized with light and dark themes', async () => {
    localStorage.setItem('canary-lab.theme', 'light')
    act(() => root.render(<TestPresentation test={TEST} sourceFile="/repo/e2e/checkout.spec.ts" />))
    await act(async () => {
      ;(container.querySelector('[data-testid="test-presentation-code-tab"]') as HTMLButtonElement).click()
      await Promise.resolve()
    })
    expect(container.querySelector('[data-shiki-theme="one-light"]')).not.toBeNull()

    await act(async () => {
      applyTheme('dark')
      await Promise.resolve()
    })
    expect(container.querySelector('[data-shiki-theme="one-dark-pro"]')).not.toBeNull()
  })
})
