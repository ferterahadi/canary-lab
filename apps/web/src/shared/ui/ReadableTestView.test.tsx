// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReadableSource, ReadableTest } from '../api/types'
import { ReadableTestView } from './ReadableTestView'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('shiki/core', () => ({
  createHighlighterCore: async () => ({
    codeToHtml: (code: string, options: { theme: string }) => (
      `<pre class="shiki" data-shiki-theme="${options.theme}"><code>${code.split('\n').map((line) => `<span class="line">${line}</span>`).join('\n')}</code></pre>`
    ),
    getTheme: (theme: string) => (theme === 'one-dark-pro' ? { bg: '#282c34', fg: '#abb2bf' } : { bg: '#fafafa', fg: '#383a42' }),
  }),
}))
vi.mock('shiki/engine/oniguruma', () => ({ createOnigurumaEngine: () => ({}) }))
vi.mock('shiki/langs/typescript.mjs', () => ({ default: {} }))
vi.mock('shiki/themes/one-dark-pro.mjs', () => ({ default: {} }))
vi.mock('shiki/themes/one-light.mjs', () => ({ default: {} }))
vi.mock('shiki/wasm', () => ({ default: {} }))

const source = (startLine: number, snippet: string, file = '/repo/e2e/checkout.spec.ts'): ReadableSource => ({
  file,
  startLine,
  endLine: startLine + snippet.split('\n').length - 1,
  snippet,
})

const READABLE: ReadableTest = {
  version: 1,
  title: 'completes checkout',
  completeness: 'partial',
  nodes: [
    {
      id: 'group-sign-in',
      kind: 'group',
      text: 'Sign in',
      fidelity: 'exact',
      source: source(10, "test.step('Sign in', async () => {})"),
      children: [{
        id: 'action-email',
        kind: 'leaf',
        role: 'action',
        text: 'Enter “ada@example.com” in the control labelled “Email”',
        fidelity: 'derived',
        source: source(11, "await page.getByLabel('Email').fill('ada@example.com')"),
      }],
    },
    {
      id: 'loop-retry',
      kind: 'loop',
      loopKind: 'for',
      count: 2,
      text: 'Repeat 2 times',
      fidelity: 'derived',
      source: source(14, 'for (let attempt = 0; attempt < 2; attempt += 1) {}'),
      children: [
        {
          id: 'loop-items',
          kind: 'loop',
          loopKind: 'for-of',
          text: 'For each item in items',
          fidelity: 'derived',
          source: source(15, 'for (const item of items) {}'),
          children: [{
            id: 'action-item',
            kind: 'leaf',
            role: 'action',
            text: 'Click the text item label',
            fidelity: 'derived',
            source: source(16, 'await page.getByText(item.label).click()'),
          }],
        },
        {
          id: 'branch-ready',
          kind: 'branch',
          text: 'If checkout is ready',
          fidelity: 'derived',
          source: source(18, 'if (ready) {}'),
          paths: [{
            id: 'path-then',
            text: 'Then',
            fidelity: 'derived',
            source: source(18, 'if (ready) {}'),
            children: [{
              id: 'unknown-handler',
              kind: 'leaf',
              role: 'unknown',
              text: 'Review this source step',
              fidelity: 'unresolved',
              source: source(19, 'await page[method](targetFromEnvironment())'),
            }],
          }],
        },
      ],
    },
  ],
}

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
})

const flushHighlighter = async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

describe('ReadableTestView', () => {
  it('keeps nested loops, groups, decisions, and paths visible with their selection state', async () => {
    act(() => root.render(<ReadableTestView test={READABLE} selectedNodeId="branch-ready" />))
    await flushHighlighter()

    expect(container.querySelectorAll('[data-readable-kind="group"]')).toHaveLength(1)
    expect(container.querySelectorAll('[data-readable-kind="loop"]')).toHaveLength(2)
    expect(container.querySelectorAll('[data-readable-kind="branch"]')).toHaveLength(1)
    expect(container.querySelectorAll('[data-readable-kind="path"]')).toHaveLength(1)
    expect(container.textContent).toContain('Sign in')
    expect(container.textContent).toContain('Repeat 2 times')
    expect(container.textContent).toContain('For each item in items')
    expect(container.textContent).toContain('If checkout is ready')
    expect(container.querySelector('[data-testid="readable-node-branch-ready"]')?.getAttribute('aria-pressed')).toBe('true')
  })

  it('renders an untranslated step as the highlighted source line itself, range still reachable', async () => {
    act(() => root.render(<ReadableTestView test={READABLE} sourceFile="/repo/e2e/checkout.spec.ts" />))
    await flushHighlighter()

    const unresolvedRow = container.querySelector('[data-testid="readable-node-unknown-handler"]')
    // No "Review this source step" filler and no fidelity tag: the code line IS
    // the row, highlighted by the same Shiki pipeline Code mode uses.
    expect(unresolvedRow?.textContent).not.toContain('Review this source step')
    expect(unresolvedRow?.textContent).not.toContain('source only')
    expect(unresolvedRow?.querySelector('[data-testid="readable-source-unknown-handler"] span.line')?.textContent)
      .toBe('await page[method](targetFromEnvironment())')
    // Hover and screen readers keep the exact file:range.
    expect(unresolvedRow?.getAttribute('title')).toContain('checkout.spec.ts:L19')
    expect(unresolvedRow?.getAttribute('aria-label')).toContain('checkout.spec.ts:L19')
    const derivedRow = container.querySelector('[data-testid="readable-node-action-email"]')
    expect(derivedRow?.getAttribute('data-fidelity')).toBe('derived')
    expect(derivedRow?.getAttribute('title')).toContain('Deterministically described from source code')
  })

  it('frames the steps in braces and indents rows the way the source itself indents', async () => {
    act(() => root.render(<ReadableTestView test={READABLE} />))
    await flushHighlighter()

    // The body reads as a block, exactly like Code mode: `{`, indented steps, `}`.
    const body = container.querySelector('.cl-readable-body') as HTMLElement
    expect(body.textContent?.trimStart().startsWith('{')).toBe(true)
    expect(body.textContent?.trimEnd().endsWith('}')).toBe(true)
    const topRow = container.querySelector('[data-testid="readable-node-group-sign-in"]') as HTMLElement
    const nestedRow = container.querySelector('[data-testid="readable-node-action-email"]') as HTMLElement
    expect(topRow.style.paddingLeft).toBe('calc(0.5rem + 2ch)')
    expect(nestedRow.style.paddingLeft).toBe('calc(0.5rem + 4ch)')
  })

  it('paints the Shiki theme canvas so English and Code share one surface', async () => {
    act(() => root.render(<ReadableTestView test={READABLE} />))
    // Before the highlighter loads, the shell tokens stand in.
    const body = container.querySelector('.cl-readable-body') as HTMLElement
    expect(body.style.backgroundColor).toBe('var(--bg-input)')
    await flushHighlighter()
    expect(body.style.backgroundColor).toBe('#282c34')
    expect(body.style.color).toBe('#abb2bf')
  })

  it('shows an expanded helper as its one-line call, never the inlined body', async () => {
    const withHelperGroup: ReadableTest = {
      ...READABLE,
      nodes: [{
        id: 'helper-publish',
        kind: 'group',
        origin: 'helper',
        text: 'Check successful publish',
        fidelity: 'derived',
        source: source(22, 'await expectSuccessfulPublish(res)'),
        children: [{
          id: 'helper-publish-inner',
          kind: 'leaf',
          role: 'check',
          text: 'Check that response status equals 200',
          fidelity: 'derived',
          source: source(40, 'expect(res.status()).toBe(200)', '/repo/e2e/helpers/publish.ts'),
        }],
      }],
    }
    act(() => root.render(<ReadableTestView test={withHelperGroup} />))
    await flushHighlighter()

    expect(container.textContent).toContain('Check successful publish')
    expect(container.textContent).not.toContain('Check that response status equals 200')
    expect(container.querySelector('[data-testid="readable-node-helper-publish-inner"]')).toBeNull()
    // A plain `test.step` group still shows its children.
    expect(READABLE.nodes[0]).toMatchObject({ kind: 'group' })
    act(() => root.render(<ReadableTestView test={READABLE} />))
    await flushHighlighter()
    expect(container.querySelector('[data-testid="readable-node-action-email"]')).not.toBeNull()
  })

  it('names the file inline only for rows translated from another file', async () => {
    const helperFile = '/repo/e2e/helpers/account.ts'
    const withHelper: ReadableTest = {
      ...READABLE,
      nodes: [
        ...READABLE.nodes,
        {
          id: 'helper-charge',
          kind: 'leaf',
          role: 'helper',
          text: 'Charge the saved card',
          fidelity: 'derived',
          source: source(30, 'await chargeSavedCard(page)', helperFile),
        },
      ],
    }
    act(() => root.render(<ReadableTestView test={withHelper} sourceFile="/repo/e2e/checkout.spec.ts" />))
    await flushHighlighter()

    expect(container.querySelector('[data-testid="readable-node-helper-charge"]')?.textContent).toContain('// account.ts')
    expect(container.querySelector('[data-testid="readable-node-action-email"]')?.textContent).not.toContain('checkout.spec.ts')
  })

  it('reports the exact source range when a nested node is selected', async () => {
    const onSourceSelect = vi.fn()
    act(() => root.render(<ReadableTestView test={READABLE} onSourceSelect={onSourceSelect} />))
    await flushHighlighter()

    act(() => {
      ;(container.querySelector('[data-testid="readable-node-unknown-handler"]') as HTMLButtonElement).click()
    })

    expect(onSourceSelect).toHaveBeenCalledWith({
      id: 'unknown-handler',
      source: source(19, 'await page[method](targetFromEnvironment())'),
    })
  })

  it('states when a test body has no executable steps', () => {
    act(() => root.render(<ReadableTestView test={{ ...READABLE, nodes: [], completeness: 'complete' }} />))
    expect(container.querySelector('[data-testid="readable-test-empty"]')?.textContent)
      .toContain('No executable steps found')
  })
})
