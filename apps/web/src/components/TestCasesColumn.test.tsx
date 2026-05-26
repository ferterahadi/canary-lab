// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, getFeatureTests } from '../api/client'
import type { FeatureTests } from '../api/types'
import { TestCasesColumn } from './TestCasesColumn'

vi.mock('../api/client', async () => {
  const actual = await vi.importActual<typeof import('../api/client')>('../api/client')
  return {
    ...actual,
    getFeatureTests: vi.fn(),
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
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
})

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
            bodySource: '',
            steps: [],
          },
        ],
      },
    ])

    await act(async () => {
      root.render(<TestCasesColumn feature="alpha" activeRunSummary={undefined} activeRunStatus={undefined} />)
    })

    expect(container.textContent).toContain('loads checkout')
    expect(container.textContent).not.toContain('Loading...')
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
          },
          {
            name: 'submits payment',
            line: 12,
            bodySource: '',
            steps: [],
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
    expect(container.querySelectorAll('.border-sky-500\\/50')).toHaveLength(2)
  })

  it('shows the yellow running-line highlight inside an expanded step body', async () => {
    vi.mocked(getFeatureTests).mockResolvedValue([
      {
        file: '/tmp/features/alpha/e2e/a.spec.ts',
        tests: [
          {
            name: 'sends message',
            line: 3,
            bodySource: "{\n  await test.step('send', async () => {\n    const payload = createPayload()\n    await send(payload)\n  })\n}",
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
                location: '/tmp/features/alpha/e2e/a.spec.ts:6:5',
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
    const stepButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === '▸sendL4')
    await act(async () => {
      stepButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await waitFor(() => Boolean(container.querySelector('[data-active-line="true"]')))

    const activeLine = container.querySelector<HTMLElement>('[data-active-line="true"]')
    expect(activeLine?.textContent).toContain('await send(payload)')
    expect(activeLine?.getAttribute('style')).toContain('rgb(234, 179, 8)')
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

    expect(container.textContent).not.toContain('Export Evaluation')
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

    expect(container.textContent).toContain("page.goto('/checkout')")
    expect(container.textContent).not.toContain('No test body available.')
  })

  it('hydrates selected run summary tests by title when source lines drift', async () => {
    vi.mocked(getFeatureTests).mockResolvedValue([
      {
        file: '/tmp/features/alpha/e2e/current.spec.ts',
        tests: [
          {
            name: 'retrieves a REJECTED record with reason populated',
            line: 396,
            bodySource: "{\n  await page.goto('/line/rejected')\n  await expect(page).toHaveText('REJECTED')\n}",
            steps: [],
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
              name: 'test-case-retrieves-a-rejected-record-with-reason-populated',
              location: '/tmp/features/alpha/e2e/current.spec.ts:396:1',
            },
            knownTests: [
              {
                id: 'test-id-rejected',
                name: 'test-case-retrieves-a-rejected-record-with-reason-populated',
                title: 'retrieves a REJECTED record with reason populated',
                location: '/tmp/features/alpha/e2e/current.spec.ts:393',
              },
            ],
          }}
        />,
      )
    })

    await act(async () => {
      container.querySelector('button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(container.textContent).toContain("page.goto('/line/rejected')")
    expect(container.textContent).not.toContain('No test body available.')
  })

  it('uses the selected run summary for counts and duplicate-title statuses', async () => {
    vi.mocked(getFeatureTests).mockResolvedValue([
      {
        file: '/tmp/features/alpha/e2e/current.spec.ts',
        tests: Array.from({ length: 33 }, (_, idx) => ({
          name: `current test ${idx + 1}`,
          line: idx + 1,
          bodySource: '',
          steps: [],
        })),
      },
    ])

    const knownTests = Array.from({ length: 31 }, (_, idx) => ({
      id: `test-id-${idx + 1}`,
      name: `test-case-run-test-${idx + 1}`,
      title: `run test ${idx + 1}`,
      location: `/tmp/features/alpha/e2e/run.spec.ts:${idx + 1}`,
    }))
    knownTests[5] = {
      id: 'test-id-duplicate-a',
      name: 'test-case-validates-duplicate',
      title: 'validates duplicate',
      location: '/tmp/features/alpha/e2e/run.spec.ts:100',
    }
    knownTests[6] = {
      id: 'test-id-duplicate-b',
      name: 'test-case-validates-duplicate',
      title: 'validates duplicate',
      location: '/tmp/features/alpha/e2e/run.spec.ts:120',
    }

    await act(async () => {
      root.render(
        <TestCasesColumn
          feature="alpha"
          activeRunStatus="aborted"
          activeRunSummary={{
            complete: false,
            total: 31,
            passed: 12,
            passedNames: [
              ...knownTests.slice(0, 5).map((test) => test.name),
              'test-case-validates-duplicate',
              ...knownTests.slice(7, 13).map((test) => test.name),
            ],
            passedIds: [
              ...knownTests.slice(0, 5).map((test) => test.id),
              'test-id-duplicate-a',
              ...knownTests.slice(7, 13).map((test) => test.id),
            ],
            knownTests,
            failed: [],
          } as any}
        />,
      )
    })

    expect(container.textContent).toContain('12/31')
    expect(container.textContent).not.toContain('13/33')
    expect(container.textContent).toContain('validates duplicate')
    expect(container.querySelectorAll('.border-emerald-500\\/40')).toHaveLength(12)
  })
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
