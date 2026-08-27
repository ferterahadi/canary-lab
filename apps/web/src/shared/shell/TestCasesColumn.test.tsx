// @vitest-environment happy-dom

import { act } from 'react'

import { createRoot, type Root } from 'react-dom/client'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ApiError, getFeatureDirtyDiff, getFeatureTests } from '../api/client'
import { readableTest } from '../api/__fixtures__/readable-test'

import type { FeatureTests } from '../api/types'

import { TestCasesColumn } from './TestCasesColumn'

vi.mock('../api/client', async () => {
  const actual = await vi.importActual<typeof import('../api/client')>('../api/client')
  return {
    ...actual,
    getFeatureTests: vi.fn(),
    getFeatureDirtyDiff: vi.fn(),
  }
})

vi.mock('shiki/core', () => ({
  createHighlighterCore: async () => ({
    codeToHtml: (code: string) => (
      `<pre class="shiki one-dark-pro"><code>${
        code.split('\n').map((line) => `<span class="line">${line}</span>`).join('\n')
      }</code></pre>`
    ),
  }),
}))

vi.mock('shiki/engine/oniguruma', () => ({ createOnigurumaEngine: () => ({}) }))

vi.mock('shiki/langs/typescript.mjs', () => ({ default: {} }))

vi.mock('shiki/themes/one-dark-pro.mjs', () => ({ default: {} }))

vi.mock('shiki/themes/one-light.mjs', () => ({ default: {} }))

vi.mock('shiki/wasm', () => ({ default: {} }))

let container: HTMLDivElement

let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  vi.mocked(getFeatureTests).mockReset()
  vi.mocked(getFeatureDirtyDiff).mockReset().mockResolvedValue({ tests: [] })
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
})

async function waitFor(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    if (condition()) return
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
  expect(condition()).toBe(true)
}

describe('TestCasesColumn', () => {
  it('shows loading while feature tests are pending', () => {
    vi.mocked(getFeatureTests).mockReturnValue(new Promise<FeatureTests>(() => {}))

    act(() => {
      root.render(<TestCasesColumn feature="alpha" activeRunSummary={undefined} activeRunStatus={undefined} />)
    })

    expect(container.textContent).toContain('Loading...')
  })

  it('renders tests after loading succeeds', async () => {
    vi.mocked(getFeatureTests).mockResolvedValue([
      {
        file: '/tmp/features/alpha/e2e/a.spec.ts',
        tests: [
          {
            name: 'loads checkout',
            line: 3,
            bodySource: "{\n  await page.goto('/checkout')\n}",
            steps: [],
            readable: readableTest('loads checkout', [{
              id: 'open-checkout',
              kind: 'leaf',
              role: 'action',
              text: 'Open “/checkout”',
              fidelity: 'derived',
              source: {
                file: '/tmp/features/alpha/e2e/a.spec.ts',
                startLine: 4,
                endLine: 4,
                snippet: "await page.goto('/checkout')",
              },
            }]),
          },
        ],
      },
    ])

    await act(async () => {
      root.render(<TestCasesColumn feature="alpha" activeRunSummary={undefined} activeRunStatus={undefined} />)
    })

    expect(container.textContent).toContain('loads checkout')
    expect(container.textContent).not.toContain('Loading...')
    await act(async () => {
      Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('loads checkout'))?.click()
    })
    expect(container.querySelector('[data-testid="test-presentation-english"]')).not.toBeNull()
    expect(container.textContent).toContain('Open “/checkout”')
    expect(container.querySelector('[data-testid="test-presentation-code"]')).toBeNull()
  })

  it('numbers tests by source order and strips a baked-in ordinal from the title', async () => {
    vi.mocked(getFeatureTests).mockResolvedValue([
      {
        file: '/tmp/features/alpha/e2e/b.spec.ts',
        tests: [{ name: 'zeta runs last alphabetically', line: 1, bodySource: '', steps: [], readable: readableTest('zeta runs last alphabetically') }],
      },
      {
        file: '/tmp/features/alpha/e2e/a.spec.ts',
        tests: [
          { name: '1. gateway is healthy', line: 30, bodySource: '', steps: [], readable: readableTest('1. gateway is healthy') },
          { name: 'happy path', line: 5, bodySource: '', steps: [], readable: readableTest('happy path') },
        ],
      },
    ])

    await act(async () => {
      root.render(<TestCasesColumn feature="alpha" activeRunSummary={undefined} activeRunStatus={undefined} />)
    })

    const rows = [...container.querySelectorAll('button')].map((el) => el.textContent ?? '')
    // a.spec.ts:5 → #1, a.spec.ts:30 → #2, b.spec.ts:1 → #3 (sorted by file then line).
    expect(rows.find((t) => t.includes('happy path'))).toContain('#1')
    expect(rows.find((t) => t.includes('gateway is healthy'))).toContain('#2')
    expect(rows.find((t) => t.includes('zeta runs last'))).toContain('#3')
    // The literal "1. " prefix is stripped for display; the badge owns numbering.
    expect(container.textContent).not.toContain('1. gateway is healthy')
    expect(container.textContent).toContain('gateway is healthy')
  })

  it('places the no-run test count on the right side of the header', async () => {
    vi.mocked(getFeatureTests).mockResolvedValue([
      {
        file: '/tmp/features/alpha/e2e/a.spec.ts',
        tests: [
          {
            name: 'loads checkout',
            line: 3,
            bodySource: '',
            steps: [],
            readable: readableTest('loads checkout'),
          },
          {
            name: 'submits payment',
            line: 12,
            bodySource: '',
            steps: [],
            readable: readableTest('submits payment'),
          },
        ],
      },
    ])

    await act(async () => {
      root.render(<TestCasesColumn feature="alpha" activeRunSummary={undefined} activeRunStatus={undefined} />)
    })

    const header = container.querySelector('.cl-panel-header')
    expect(header?.children[0]?.textContent).toBe('Tests')
    expect(header?.children[1]?.textContent).toBe('2')
    expect(header?.textContent).not.toContain('0/2')
  })

  it('shows that the selected run is active before a specific test is reported', async () => {
    vi.mocked(getFeatureTests).mockResolvedValue([
      {
        file: '/tmp/features/alpha/e2e/a.spec.ts',
        tests: [
          {
            name: 'loads checkout',
            line: 3,
            bodySource: '',
            steps: [],
            readable: readableTest('loads checkout'),
          },
        ],
      },
    ])

    await act(async () => {
      root.render(<TestCasesColumn feature="alpha" activeRunSummary={undefined} activeRunStatus="running" />)
    })

    expect(container.textContent).toContain('Running')
    expect(container.textContent).toContain('0/1')
  })

  it('marks the currently running test card when Playwright reports one', async () => {
    vi.mocked(getFeatureTests).mockResolvedValue([
      {
        file: '/tmp/features/alpha/e2e/a.spec.ts',
        tests: [
          {
            name: 'loads checkout',
            line: 3,
            bodySource: '',
            steps: [],
            readable: readableTest('loads checkout'),
          },
        ],
      },
    ])

    await act(async () => {
      root.render(
        <TestCasesColumn
          feature="alpha"
          activeRunStatus="running"
          activeRunSummary={{
            complete: false,
            total: 1,
            passed: 0,
            passedNames: [],
            failed: [],
            running: {
              name: 'test-case-loads-checkout',
              location: '/tmp/features/alpha/e2e/a.spec.ts:3:1',
            },
          }}
        />,
      )
    })

    expect(container.textContent).toContain('loads checkout')
    expect(container.textContent).toContain('Running')
  })

  it('marks multiple currently running test cards when Playwright workers run in parallel', async () => {
    vi.mocked(getFeatureTests).mockResolvedValue([
      {
        file: '/tmp/features/alpha/e2e/a.spec.ts',
        tests: [
          {
            name: 'loads checkout',
            line: 3,
            bodySource: '',
            steps: [],
            readable: readableTest('loads checkout'),
          },
          {
            name: 'submits payment',
            line: 12,
            bodySource: '',
            steps: [],
            readable: readableTest('submits payment'),
          },
        ],
      },
    ])

    await act(async () => {
      root.render(
        <TestCasesColumn
          feature="alpha"
          activeRunStatus="running"
          activeRunSummary={{
            complete: false,
            total: 2,
            passed: 0,
            passedNames: [],
            failed: [],
            running: {
              name: 'test-case-loads-checkout',
              location: '/tmp/features/alpha/e2e/a.spec.ts:3:1',
            },
            runningTests: [
              {
                name: 'test-case-loads-checkout',
                location: '/tmp/features/alpha/e2e/a.spec.ts:3:1',
              },
              {
                name: 'test-case-submits-payment',
                location: '/tmp/features/alpha/e2e/a.spec.ts:12:1',
              },
            ],
          }}
        />,
      )
    })

    expect(container.textContent).toContain('loads checkout')
    expect(container.textContent).toContain('submits payment')
    expect(container.querySelectorAll('.border-running\\/50')).toHaveLength(2)
  })

  it('shows the amber running-line highlight inside the expanded Code view', async () => {
    vi.mocked(getFeatureTests).mockResolvedValue([
      {
        file: '/tmp/features/alpha/e2e/a.spec.ts',
        tests: [
          {
            name: 'sends message',
            line: 3,
            bodyLine: 5,
            bodySource: "{\n  await test.step('send', async () => {\n    const payload = createPayload()\n    await send(payload)\n  })\n}",
            readable: readableTest('sends message'),
            steps: [
              {
                label: 'send',
                line: 4,
                bodySource: '{\n  const payload = createPayload()\n  await send(payload)\n}',
                children: [],
              },
            ],
          },
        ],
      },
    ])

    await act(async () => {
      root.render(
        <TestCasesColumn
          feature="alpha"
          activeRunStatus="running"
          activeRunSummary={{
            complete: false,
            total: 1,
            passed: 0,
            passedNames: [],
            failed: [],
            running: {
              name: 'test-case-sends-message',
              location: '/tmp/features/alpha/e2e/a.spec.ts:3:1',
              step: {
                title: 'send payload',
                category: 'test.step',
                location: '/tmp/features/alpha/e2e/a.spec.ts:8:5',
              },
            },
          }}
        />,
      )
    })

    const buttons = Array.from(container.querySelectorAll('button'))
    const testButton = buttons.find((button) => button.textContent?.includes('sends message'))
    await act(async () => {
      testButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await act(async () => {
      ;(container.querySelector('[data-testid="test-presentation-code-tab"]') as HTMLButtonElement).click()
    })
    await waitFor(() => Boolean(container.querySelector('[data-active-line="true"]')))

    const activeLine = container.querySelector<HTMLElement>('[data-active-line="true"]')
    expect(activeLine?.textContent).toContain('await send(payload)')
    expect(activeLine?.getAttribute('style')).toContain('var(--warning)')
    expect(container.textContent).toContain('Latest Playwright step · line 8 · test.step')

    await act(async () => {
      root.render(
        <TestCasesColumn
          feature="alpha"
          activeRunStatus="running"
          activeRunSummary={{
            complete: false,
            total: 1,
            passed: 0,
            passedNames: [],
            failed: [],
            running: {
              name: 'test-case-sends-message',
              location: '/tmp/features/alpha/e2e/a.spec.ts:3:1',
              step: {
                title: 'send request',
                category: 'pw:api',
                location: '/tmp/features/alpha/helpers/send.ts:8:5',
              },
            },
          }}
        />,
      )
    })
    await waitFor(() => container.querySelector('[data-active-line="true"]') === null)
    expect(container.textContent).toContain('Latest Playwright step · pw:api · source line unavailable')
    expect(container.textContent).not.toContain('Latest Playwright step · line 8')
  })

  it('rings only the test named in affectedTests, not every card in the spec', async () => {
    vi.mocked(getFeatureTests).mockResolvedValue([
      {
        file: '/tmp/features/alpha/e2e/a.spec.ts',
        tests: [
          { name: 'a', line: 3, bodySource: '', steps: [], readable: readableTest('a') },
          { name: 'b', line: 12, bodySource: '', steps: [], readable: readableTest('b') },
        ],
      },
    ])

    await act(async () => {
      root.render(
        <TestCasesColumn
          feature="alpha"
          activeRunSummary={undefined}
          activeRunStatus={undefined}
          dirtySpecs={[{ file: 'e2e/a.spec.ts', affectedTests: ['b'] }]}
        />,
      )
    })

    const cardFor = (name: string) => {
      const button = Array.from(container.querySelectorAll('button')).find((el) => el.textContent?.includes(name))
      return button?.closest('.cl-card') as HTMLElement | null
    }
    expect(cardFor('b')?.style.boxShadow).toContain('var(--danger)')
    expect(cardFor('a')?.style.boxShadow ?? '').not.toContain('var(--danger)')
  })

  it('highlights only the line(s) the server reports as changed for a dirty test', async () => {
    vi.mocked(getFeatureTests).mockResolvedValue([
      {
        file: '/tmp/features/alpha/e2e/a.spec.ts',
        tests: [
          { name: 'a', line: 3, bodySource: '{\n  const x = 1\n  expect(x).toBe(2)\n}', steps: [], readable: readableTest('a') },
        ],
      },
    ])
    vi.mocked(getFeatureDirtyDiff).mockResolvedValue({
      tests: [{ name: 'a', changedLines: [3] }],
    })

    await act(async () => {
      root.render(
        <TestCasesColumn
          feature="alpha"
          activeRunSummary={undefined}
          activeRunStatus={undefined}
          dirtySpecs={[{ file: 'e2e/a.spec.ts', affectedTests: ['a'] }]}
        />,
      )
    })

    await act(async () => {
      container.querySelector('button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await act(async () => {
      ;(container.querySelector('[data-testid="test-presentation-code-tab"]') as HTMLButtonElement).click()
    })
    await waitFor(() => Boolean(container.querySelector('[data-changed-line="true"]')))

    const changedLines = container.querySelectorAll('[data-changed-line="true"]')
    expect(changedLines).toHaveLength(1)
    expect(changedLines[0].textContent).toContain('toBe(2)')
  })

  it('renders an error when feature tests fail to load', async () => {
    vi.mocked(getFeatureTests).mockRejectedValue(new ApiError(500, { error: 'boom' }))

    await act(async () => {
      root.render(<TestCasesColumn feature="alpha" activeRunSummary={undefined} activeRunStatus={undefined} />)
    })

    expect(container.textContent).toContain('Unable to load tests for this feature. Server returned HTTP 500.')
    expect(container.textContent).not.toContain('Loading...')
  })

  it('does not render the evaluation export in the tests pane', async () => {
    vi.mocked(getFeatureTests).mockResolvedValue([])

    await act(async () => {
      root.render(<TestCasesColumn feature="alpha beta" activeRunSummary={undefined} activeRunStatus="passed" />)
    })

    expect(container.textContent).not.toContain('Review Evaluation')
  })

  it('hydrates selected run summary tests with parsed spec code when location still matches', async () => {
    vi.mocked(getFeatureTests).mockResolvedValue([
      {
        file: '/tmp/features/alpha/e2e/current.spec.ts',
        tests: [
          {
            name: 'validates checkout',
            line: 14,
            bodySource: "{\n  await page.goto('/checkout')\n  await expect(page).toHaveURL(/checkout/)\n}",
            steps: [],
            readable: readableTest('validates checkout'),
          },
        ],
      },
    ])

    await act(async () => {
      root.render(
        <TestCasesColumn
          feature="alpha"
          activeRunStatus="passed"
          activeRunSummary={{
            complete: true,
            total: 1,
            passed: 1,
            passedNames: ['test-case-validates-checkout'],
            passedIds: ['test-id-checkout'],
            knownTests: [
              {
                id: 'test-id-checkout',
                name: 'test-case-validates-checkout',
                title: 'validates checkout',
                location: '/tmp/features/alpha/e2e/current.spec.ts:14',
              },
            ],
            failed: [],
          }}
        />,
      )
    })

    await act(async () => {
      container.querySelector('button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await act(async () => {
      ;(container.querySelector('[data-testid="test-presentation-code-tab"]') as HTMLButtonElement).click()
    })

    expect(container.textContent).toContain("page.goto('/checkout')")
    expect(container.textContent).not.toContain('No test body available.')
  })
})
