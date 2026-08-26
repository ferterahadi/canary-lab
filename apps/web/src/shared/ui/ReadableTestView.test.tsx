// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReadableSource, ReadableTest } from '../api/types'
import { ReadableTestView } from './ReadableTestView'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

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

describe('ReadableTestView', () => {
  it('keeps nested loops, groups, decisions, paths, fidelity, and unresolved source visible', () => {
    act(() => root.render(<ReadableTestView test={READABLE} selectedNodeId="branch-ready" />))

    expect(container.querySelectorAll('[data-readable-kind="group"]')).toHaveLength(1)
    expect(container.querySelectorAll('[data-readable-kind="loop"]')).toHaveLength(2)
    expect(container.querySelectorAll('[data-readable-kind="branch"]')).toHaveLength(1)
    expect(container.querySelectorAll('[data-readable-kind="path"]')).toHaveLength(1)
    expect(container.textContent).toContain('Sign in')
    expect(container.textContent).toContain('Repeat 2 times')
    expect(container.textContent).toContain('For each item in items')
    expect(container.textContent).toContain('If checkout is ready')
    expect(container.textContent).toContain('authored')
    expect(container.textContent).toContain('rule-based')
    expect(container.textContent).toContain('source only')
    expect(container.textContent).toContain('checkout.spec.ts:L19')
    expect(container.querySelector('[data-testid="readable-source-unknown-handler"]')?.textContent)
      .toContain('await page[method](targetFromEnvironment())')
    expect(container.querySelector('[data-testid="readable-node-branch-ready"]')?.getAttribute('aria-pressed')).toBe('true')
  })

  it('reports the exact source range when a nested node is selected', () => {
    const onSourceSelect = vi.fn()
    act(() => root.render(<ReadableTestView test={READABLE} onSourceSelect={onSourceSelect} />))

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
