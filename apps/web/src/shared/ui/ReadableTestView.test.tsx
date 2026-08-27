// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReadableSource, ReadableTest } from '../api/types'
import { ReadableTestView } from './ReadableTestView'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const highlighter = vi.hoisted(() => ({ load: vi.fn() }))
vi.mock('./code-highlighter', () => ({
  codeThemeFor: (resolved: 'dark' | 'light') => resolved === 'dark' ? 'one-dark-pro' : 'one-light',
  getCodeHighlighter: () => highlighter.load(),
}))

const source = (startLine: number, snippet: string, file = '/repo/e2e/checkout.spec.ts'): ReadableSource => ({
  file,
  startLine,
  endLine: startLine + snippet.split('\n').length - 1,
  snippet,
})

const STORY: ReadableTest = {
  version: 2,
  title: 'completes checkout',
  completeness: 'complete',
  story: {
    steps: [
      {
        id: 'setup-identifiers',
        role: 'setup',
        text: 'Prepare unique identifiers',
        spans: [
          { text: 'Prepare unique ' },
          { text: 'identifiers', kind: 'variable' },
        ],
        fidelity: 'derived',
        source: source(10, 'const ids = makeIds()\nuse(ids)'),
      },
      {
        id: 'action-submit',
        role: 'action',
        text: 'Submit the checkout form',
        spans: [{ text: 'Submit the checkout form' }],
        fidelity: 'exact',
        source: source(11, "test.step('Submit the checkout form', async () => {})"),
      },
      {
        id: 'check-order',
        role: 'check',
        text: 'Check that order status equals “confirmed”',
        spans: [
          { text: 'Check that ' },
          { text: 'order', kind: 'variable' },
          { text: ' status equals “confirmed”' },
        ],
        fidelity: 'derived',
        source: source(30, "expect(order.status).toBe('confirmed')", '/repo/helpers/order.ts'),
      },
    ],
  },
  // The exhaustive mapping remains server-internal; English mode neither
  // renders nor requires it.
  nodes: [],
}

let container: HTMLDivElement
let root: Root
let rootMounted: boolean

beforeEach(() => {
  localStorage.setItem('canary-lab.theme', 'dark')
  document.documentElement.classList.add('dark')
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  rootMounted = true
  highlighter.load.mockReset()
  highlighter.load.mockResolvedValue({
    themeColors: (theme: string) => (
      theme === 'one-dark-pro'
        ? { bg: '#282c34', fg: '#abb2bf' }
        : { bg: '#fafafa', fg: '#383a42' }
    ),
  })
})

afterEach(() => {
  if (rootMounted) act(() => root.unmount())
  container.remove()
  document.documentElement.classList.remove('dark')
})

async function flushHighlighter(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

describe('ReadableTestView', () => {
  it('keeps authored execution order with highlighted role keywords and variables', async () => {
    act(() => root.render(<ReadableTestView test={STORY} sourceFile="/repo/e2e/checkout.spec.ts" />))

    const body = container.querySelector('.cl-readable-body') as HTMLElement
    expect(body.style.backgroundColor).toBe('var(--bg-input)')
    await flushHighlighter()
    expect(body.style.backgroundColor).toBe('#282c34')
    expect(body.style.color).toBe('#abb2bf')

    const rows = Array.from(container.querySelectorAll('[data-story-sequence]'))
    expect(rows.map((row) => row.getAttribute('data-story-role'))).toEqual(['setup', 'action', 'check'])
    expect(rows.map((row) => row.textContent?.trim())).toEqual([
      '01SETUPPrepare unique identifiers',
      '02ACTIONSubmit the checkout form',
      '03CHECKCheck that order status equals “confirmed” // order.ts',
    ])
    expect((container.querySelector('[data-testid="readable-story-role-setup-identifiers"]') as HTMLElement).style.color)
      .toBe('var(--code-cyan)')
    expect((container.querySelector('[data-testid="readable-story-role-action-submit"]') as HTMLElement).style.color)
      .toBe('var(--code-keyword)')
    expect((container.querySelector('[data-testid="readable-story-role-check-order"]') as HTMLElement).style.color)
      .toBe('var(--semantic-attention)')
    expect(Array.from(container.querySelectorAll('[data-story-span="variable"]')).map((span) => span.textContent))
      .toEqual(['identifiers', 'order'])
    expect((container.querySelector('[data-story-span="variable"]') as HTMLElement).style.color)
      .toBe('var(--code-string)')
    expect(container.textContent).not.toContain('Details')
    expect(container.textContent).not.toContain('Full deterministic mapping')
    expect(container.querySelector('[data-testid="readable-test-tree"]')).toBeNull()
    expect(container.querySelector('[data-testid="readable-story-item-setup-identifiers"]')?.getAttribute('title'))
      .toContain('checkout.spec.ts:L10–11')
  })

  it('opens the exact source for an ordered row and shows selection state', () => {
    const onSourceSelect = vi.fn()
    act(() => root.render(
      <ReadableTestView
        test={STORY}
        sourceFile="/repo/e2e/checkout.spec.ts"
        selectedNodeId="action-submit"
        onSourceSelect={onSourceSelect}
      />,
    ))

    const action = container.querySelector('[data-testid="readable-story-item-action-submit"]') as HTMLButtonElement
    expect(action.getAttribute('aria-pressed')).toBe('true')
    expect(action.getAttribute('title')).toContain('checkout.spec.ts:L11')
    expect(action.getAttribute('title')).toContain('Original wording')

    const check = container.querySelector('[data-testid="readable-story-item-check-order"]') as HTMLButtonElement
    expect(check.getAttribute('aria-label')).toContain('3. CHECK')
    expect(check.getAttribute('aria-label')).toContain('order.ts:L30')
    act(() => check.click())
    expect(onSourceSelect).toHaveBeenCalledWith({
      id: 'check-order',
      source: source(30, "expect(order.status).toBe('confirmed')", '/repo/helpers/order.ts'),
    })
  })

  it('states when no concise story steps were proven', () => {
    act(() => root.render(<ReadableTestView test={{ ...STORY, story: undefined }} />))
    expect(container.querySelector('[data-testid="readable-test-empty"]')?.textContent)
      .toContain('No readable steps found')
  })

  it('keeps shell colours when Shiki has no canvas colours or fails to load', async () => {
    highlighter.load.mockResolvedValueOnce({ themeColors: () => ({}) })
    act(() => root.render(<ReadableTestView test={STORY} />))
    await flushHighlighter()
    const body = container.querySelector('.cl-readable-body') as HTMLElement
    expect(body.style.backgroundColor).toBe('var(--bg-input)')
    expect(body.style.color).toBe('var(--text-primary)')

    highlighter.load.mockRejectedValueOnce(new Error('theme unavailable'))
    act(() => root.render(null))
    act(() => root.render(<ReadableTestView test={{ ...STORY, title: 'another test' }} />))
    await flushHighlighter()
    expect((container.querySelector('.cl-readable-body') as HTMLElement).style.backgroundColor)
      .toBe('var(--bg-input)')
  })

  it('ignores a highlighter result after the reader unmounts', async () => {
    let resolveHighlighter: ((value: { themeColors: () => { bg: string; fg: string } }) => void) | undefined
    highlighter.load.mockReturnValueOnce(new Promise((resolve) => { resolveHighlighter = resolve }))
    act(() => root.render(<ReadableTestView test={STORY} />))
    act(() => root.unmount())
    rootMounted = false
    await act(async () => {
      resolveHighlighter?.({ themeColors: () => ({ bg: '#111111', fg: '#eeeeee' }) })
      await Promise.resolve()
    })
  })

  it('ignores a highlighter failure after the reader unmounts', async () => {
    let rejectHighlighter: ((reason: Error) => void) | undefined
    highlighter.load.mockReturnValueOnce(new Promise((_resolve, reject) => { rejectHighlighter = reject }))
    act(() => root.render(<ReadableTestView test={STORY} />))
    act(() => root.unmount())
    rootMounted = false
    await act(async () => {
      rejectHighlighter?.(new Error('late failure'))
      await Promise.resolve()
    })
  })
})
