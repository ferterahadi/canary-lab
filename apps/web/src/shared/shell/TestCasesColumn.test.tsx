// @vitest-environment happy-dom

import { act } from 'react'

import { createRoot, type Root } from 'react-dom/client'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ApiError, getTestFileReview, getTestSourceComparison, getFeatureTests } from '../api/client'
import { readableTest } from '../api/__fixtures__/readable-test'

import type { FeatureTests } from '../api/types'

import { TestCasesColumn } from './TestCasesColumn'

vi.mock('../api/client', async () => {
  const actual = await vi.importActual<typeof import('../api/client')>('../api/client')
  return {
    ...actual,
    getFeatureTests: vi.fn(),
    getTestFileReview: vi.fn(),
    getTestSourceComparison: vi.fn(),
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
  vi.mocked(getTestSourceComparison).mockReset().mockResolvedValue({ state: 'ready', files: [], differences: [], changes: { added: [], changed: [], removed: [] } })
  vi.mocked(getTestFileReview).mockReset().mockRejectedValue(new Error('No baseline'))
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

function statusBadges(): string[] {
  return [...container.querySelectorAll('span')]
    .map((span) => span.textContent ?? '')
    .filter((text) => text === 'passed' || text === 'pending' || text === 'failed')
}

describe('TestCasesColumn', () => {
  it('states only that no suite is picked, with no body to restate it', async () => {
    await act(async () => {
      root.render(<TestCasesColumn feature={null} activeRunSummary={undefined} activeRunStatus={undefined} />)
    })

    const empty = container.querySelector('[data-testid="tests-no-suite"]')
    expect(empty?.textContent).toBe('No suite selected')
    expect(empty?.getAttribute('data-compact')).toBe('')
    expect(getFeatureTests).not.toHaveBeenCalled()
  })

  it('holds the list\u2019s own shape while the fetch is in flight', () => {
    vi.mocked(getFeatureTests).mockReturnValue(new Promise<FeatureTests>(() => {}))

    act(() => {
      root.render(<TestCasesColumn feature="alpha" activeRunSummary={undefined} activeRunStatus={undefined} />)
    })

    const placeholder = container.querySelector('[data-testid="tests-loading-placeholder"]')
    expect(placeholder?.querySelectorAll('[data-testid="test-card-skeleton"]')).toHaveLength(3)
    expect(placeholder?.querySelector('.sr-only')?.textContent).toContain('Loading test cases')
    expect(container.textContent).not.toContain('Loading...')
  })

  it('does not flash the old filtered count while the full saved suite is loading', async () => {
    vi.mocked(getFeatureTests).mockReturnValue(new Promise<FeatureTests>(() => {}))
    await act(async () => {
      root.render(<TestCasesColumn feature="alpha" activeRunStatus="aborted" activeRunManifest={{ runId: 'meta' }} activeRunSummary={{ complete: true, total: 4, passed: 2, failed: [] }} />)
    })
    expect(container.querySelector('[data-testid="tests-loading-placeholder"]')).not.toBeNull()
    expect(container.querySelector('.cl-panel-header')?.textContent).not.toContain('2/4')
  })
  it('shows the full recorded suite with missing execution evidence labelled not run', async () => {
    const file = '/tmp/logs/runs/meta/suite/e2e/all.spec.ts'
    const names = ['local one', 'local two', 'meta case']
    vi.mocked(getFeatureTests).mockResolvedValue([{ file, tests: names.map((name, index) => ({ name, line: index + 1, bodySource: '', steps: [], readable: readableTest(name) })) }])
    await act(async () => {
      root.render(<TestCasesColumn feature="alpha" activeRunStatus="passed" activeRunManifest={{ runId: 'meta' }} activeRunSummary={{
        complete: true, total: 1, passed: 1, failed: [], passedNames: ['test-case-meta-case'], passedIds: ['meta'],
        knownTests: [{ id: 'meta', name: 'test-case-meta-case', title: 'meta case', location: `${file}:3` }],
      }} />)
    })
    expect(container.querySelector('.cl-panel-header')?.textContent).toContain('1/3')
    expect(container.querySelector('.cl-panel-header')?.textContent).not.toContain('not run')
    const cards = [...container.querySelectorAll('.cl-card')]
    expect(cards).toHaveLength(3)
    expect(cards[0].textContent).toContain('not run')
    expect(cards[1].textContent).toContain('not run')
    expect(cards[2].textContent).toContain('passed')
    expect(container.textContent).not.toContain('skipped')
  })
  it('shows loading while feature tests are pending', () => {
    vi.mocked(getFeatureTests).mockReturnValue(new Promise<FeatureTests>(() => {}))

    act(() => {
      root.render(<TestCasesColumn feature="alpha" activeRunSummary={undefined} activeRunStatus={undefined} />)
    })

    expect(container.querySelector('[data-testid="tests-loading-placeholder"]')).not.toBeNull()
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
    expect(container.querySelector('[data-testid="tests-loading-placeholder"]')).toBeNull()
    expect(container.querySelectorAll('.cl-card > button > span.uppercase')).toHaveLength(0)
    expect(container.querySelector('[data-testid="test-presentation-english"]')).not.toBeNull()
    expect(container.textContent).toContain('Open “/checkout”')
    expect(container.querySelector('[data-testid="test-presentation-code"]')).toBeNull()
  })

  it('expands the first test whenever a different suite is selected', async () => {
    vi.mocked(getFeatureTests).mockImplementation(async (feature) => [{
      file: `/tmp/features/${feature}/e2e/a.spec.ts`,
      tests: [
        {
          name: `${feature} first test`,
          line: 3,
          bodySource: '',
          steps: [],
          readable: readableTest(`${feature} first test`, [{
            id: `${feature}-first-step`,
            kind: 'leaf',
            role: 'action',
            text: `Run ${feature} first step`,
            fidelity: 'derived',
            source: {
              file: `/tmp/features/${feature}/e2e/a.spec.ts`,
              startLine: 4,
              endLine: 4,
              snippet: `run${feature}FirstStep()`,
            },
          }]),
        },
        {
          name: `${feature} second test`,
          line: 10,
          bodySource: '',
          steps: [],
          readable: readableTest(`${feature} second test`),
        },
      ],
    }])

    await act(async () => {
      root.render(<TestCasesColumn feature="alpha" activeRunSummary={undefined} activeRunStatus={undefined} />)
    })

    expect(container.textContent).toContain('Run alpha first step')
    expect(container.querySelectorAll('[data-testid="test-presentation-english"]')).toHaveLength(1)

    await act(async () => {
      Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('alpha first test'))?.click()
    })
    expect(container.querySelector('[data-testid="test-presentation-english"]')).toBeNull()

    await act(async () => {
      root.render(<TestCasesColumn feature="alpha" activeRunSummary={undefined} activeRunStatus={undefined} />)
    })
    expect(container.querySelector('[data-testid="test-presentation-english"]')).toBeNull()

    await act(async () => {
      root.render(<TestCasesColumn feature="beta" activeRunSummary={undefined} activeRunStatus={undefined} />)
    })

    expect(container.textContent).toContain('Run beta first step')
    expect(container.querySelectorAll('[data-testid="test-presentation-english"]')).toHaveLength(1)
    expect(container.textContent).not.toContain('Run alpha first step')
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

  it('keeps the no-run test count beside the Tests kicker with no version control', async () => {
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

    // The compact header keeps the count beside its kicker without implying a
    // recorded result or offering version controls when no run is selected.
    const header = container.querySelector('.cl-panel-header')
    expect(header?.querySelector('.cl-kicker')?.textContent).toBe('Tests')
    expect(header?.querySelector('.cl-count-chip')?.textContent).toBe('2')
    expect(header?.querySelector('[aria-label="Test source"]')).toBeNull()
    expect(header?.querySelector('[data-testid="test-version-compare"]')).toBeNull()
    expect(header?.textContent).not.toContain('0/2')
  })

  it('marks a recorded roster as the run\'s own, so its count is not read as the suite\'s', async () => {
    // A run keeps the roster it DECLARED and that record is never rewritten, so
    // a run recorded while the config still picked specs by envset counts 4
    // against a suite holding 45. A bare "Tests" states the run's number as the
    // suite's — which is the confusion the envset forbid exists to end. The
    // marker names the owner; `Source` is its opposite half.
    vi.mocked(getFeatureTests).mockResolvedValue([
      {
        file: '/tmp/features/alpha/e2e/meta.spec.ts',
        tests: [{ name: 'connects meta', line: 3, bodySource: '', steps: [], readable: readableTest('connects meta') }],
      },
    ])

    await act(async () => {
      root.render(
        <TestCasesColumn
          feature="alpha"
          activeRunStatus="passed"
          activeRunManifest={{ runId: 'r1' }}
          activeRunSummary={{ complete: true, total: 1, passed: 1, passedNames: ['test-case-connects-meta'], failed: [] }}
        />,
      )
    })

    const header = container.querySelector('.cl-panel-header')
    expect(header?.textContent).toContain('Recorded tests')
    expect(header?.textContent).toContain('1/1')
  })

  it('leaves the header unmarked when no run owns the list', async () => {
    // The default view carries no provenance label: with nothing recorded on
    // screen, the column IS the workspace and there is no second owner to
    // distinguish it from.
    vi.mocked(getFeatureTests).mockResolvedValue([
      {
        file: '/tmp/features/alpha/e2e/a.spec.ts',
        tests: [{ name: 'loads checkout', line: 3, bodySource: '', steps: [], readable: readableTest('loads checkout') }],
      },
    ])

    await act(async () => {
      root.render(<TestCasesColumn feature="alpha" activeRunSummary={undefined} activeRunStatus={undefined} />)
    })

    const header = container.querySelector('.cl-panel-header')
    expect(header?.textContent).not.toContain('Recorded tests')
    expect(header?.textContent).not.toContain('Current source')
  })

  it('names the skipped tests beside the pass count so the roster adds up', async () => {
    // Spec selection cannot vary by envset, so the denominator is the suite's
    // WHOLE roster in every environment. An envset only a few tests apply to
    // then reads as "1/3" and looks like a run that went badly; naming the
    // skipped tests closes the arithmetic — 1 passed + 2 skipped IS the suite.
    vi.mocked(getFeatureTests).mockResolvedValue([
      {
        file: '/tmp/features/alpha/e2e/a.spec.ts',
        tests: [
          { name: 'loads checkout', line: 3, bodySource: '', steps: [], readable: readableTest('loads checkout') },
          { name: 'connects meta', line: 12, bodySource: '', steps: [], readable: readableTest('connects meta') },
          { name: 'connects reserve', line: 20, bodySource: '', steps: [], readable: readableTest('connects reserve') },
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
            total: 3,
            passed: 1,
            passedNames: ['test-case-loads-checkout'],
            skippedNames: ['test-case-connects-meta', 'test-case-connects-reserve'],
            failed: [],
          }}
        />,
      )
    })

    const header = container.querySelector('.cl-panel-header')
    expect(header?.textContent).toContain('1/3')
    expect(header?.textContent).toContain('2 skipped')
  })

  it('leaves the skipped segment off a run that skipped nothing', async () => {
    // Never-run tests are deliberately NOT totalled here: a test absent from
    // every result list is not run, and the absence of information is not a
    // status. A run that stopped early shows 1/3 and no segment.
    vi.mocked(getFeatureTests).mockResolvedValue([
      {
        file: '/tmp/features/alpha/e2e/a.spec.ts',
        tests: [
          { name: 'loads checkout', line: 3, bodySource: '', steps: [], readable: readableTest('loads checkout') },
          { name: 'connects meta', line: 12, bodySource: '', steps: [], readable: readableTest('connects meta') },
          { name: 'connects reserve', line: 20, bodySource: '', steps: [], readable: readableTest('connects reserve') },
        ],
      },
    ])

    await act(async () => {
      root.render(
        <TestCasesColumn
          feature="alpha"
          activeRunStatus="aborted"
          activeRunSummary={{ complete: false, total: 3, passed: 1, passedNames: ['test-case-loads-checkout'], failed: [] }}
        />,
      )
    })

    const header = container.querySelector('.cl-panel-header')
    expect(header?.textContent).toContain('1/3')
    expect(header?.textContent).not.toContain('skipped')
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

  it('moves the runner-owned highlight from the current line to the last failed line in English and Code', async () => {
    vi.mocked(getFeatureTests).mockResolvedValue([
      {
        file: '/tmp/features/alpha/e2e/a.spec.ts',
        tests: [
          {
            name: 'sends message',
            line: 3,
            bodyLine: 5,
            bodySource: "{\n  await test.step('send', async () => {\n    const payload = createPayload()\n    await send(payload)\n  })\n}",
            readable: readableTest('sends message', [
              {
                id: 'create-payload',
                kind: 'leaf',
                role: 'setup',
                text: 'Create the payload',
                fidelity: 'derived',
                source: {
                  file: '/tmp/features/alpha/e2e/a.spec.ts',
                  startLine: 7,
                  endLine: 7,
                  snippet: 'const payload = createPayload()',
                },
              },
              {
                id: 'send-payload',
                kind: 'leaf',
                role: 'action',
                text: 'Send the payload',
                fidelity: 'derived',
                source: {
                  file: '/tmp/features/alpha/e2e/a.spec.ts',
                  startLine: 8,
                  endLine: 8,
                  snippet: 'await send(payload)',
                },
              },
            ]),
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

    const runningEnglish = container.querySelector<HTMLElement>('[data-execution-highlight="running"]')
    expect(runningEnglish?.textContent).toContain('Send the payload')
    expect(runningEnglish?.getAttribute('style')).toContain('var(--running)')

    await act(async () => {
      ;(container.querySelector('[data-testid="test-presentation-code-tab"]') as HTMLButtonElement).click()
    })
    await waitFor(() => Boolean(container.querySelector('[data-active-line="true"]')))

    const activeLine = container.querySelector<HTMLElement>('[data-active-line="true"]')
    expect(activeLine?.textContent).toContain('await send(payload)')
    expect(activeLine?.dataset.executionHighlight).toBe('running')
    expect(activeLine?.getAttribute('style')).toContain('var(--running)')
    expect(container.textContent).toContain('Running now · line 8 · test.step')

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
    expect(container.textContent).toContain('Running now · pw:api · source line unavailable')
    expect(container.textContent).not.toContain('Running now · line 8')

    await act(async () => {
      root.render(
        <TestCasesColumn
          feature="alpha"
          activeRunStatus="healing"
          activeRunSummary={{
            complete: true,
            total: 1,
            passed: 0,
            passedNames: [],
            failed: [{
              name: 'test-case-sends-message',
              location: '/tmp/features/alpha/e2e/a.spec.ts:3:1',
              locations: ['/tmp/features/alpha/e2e/a.spec.ts:7:5'],
            }],
          }}
        />,
      )
    })
    await waitFor(() => container.querySelector<HTMLElement>('[data-execution-highlight="failed"]')?.textContent?.includes('createPayload') === true)

    const failedCode = container.querySelector<HTMLElement>('[data-execution-highlight="failed"]')
    expect(failedCode?.dataset.activeLine).toBe('true')
    expect(failedCode?.getAttribute('style')).toContain('var(--danger)')
    expect(failedCode?.textContent).toContain('FAILED HERE')
    expect(container.textContent).not.toContain('Last failed line')

    await act(async () => {
      ;(container.querySelector('[data-testid="test-presentation-english-tab"]') as HTMLButtonElement).click()
    })
    const failedEnglish = container.querySelector<HTMLElement>('[data-execution-highlight="failed"]')
    expect(failedEnglish?.textContent).toContain('Create the payload')
    expect(failedEnglish?.textContent).toContain('FAILED HERE')
    expect(failedEnglish?.getAttribute('style')).toContain('var(--danger)')
  })

  it('marks edited tests without a review control anywhere in the Tests column', async () => {
    const review = vi.fn()
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
          onReviewTest={review}
        />,
      )
    })

    const cardFor = (name: string) => {
      const button = Array.from(container.querySelectorAll('.cl-card > button')).find((el) => el.textContent?.includes(name))
      return button?.closest('.cl-card') as HTMLElement | null
    }
    expect(cardFor('b')?.style.boxShadow ?? '').not.toContain('var(--danger)')
    expect(cardFor('b')?.querySelector('[data-testid="test-modified-dot"]')).not.toBeNull()
    expect(cardFor('a')?.querySelector('[data-testid="test-modified-dot"]')).toBeNull()
    expect(cardFor('b')?.textContent).not.toContain('Review changes')
    expect(container.textContent).not.toContain('Test edited · execution status unchanged')
    expect(cardFor('a')?.textContent).not.toContain('Review changes')
    expect(cardFor('a')?.style.boxShadow ?? '').not.toContain('var(--danger)')
    // Uncommitted-vs-HEAD is version control, not evidence: its review entrance
    // lives on the Suites row. With no run on screen this column offers none, so
    // the same action never appears in two places with two baselines.
    expect(container.querySelector('[data-testid="suite-version-menu"]')).toBeNull()
    expect(Array.from(container.querySelectorAll('button')).map((button) => button.textContent))
      .not.toContain('Review 1 file')
    expect(review).not.toHaveBeenCalled()
  })

  it.each(['weaker', 'stronger', 'equivalent', 'unclassifiable'] as const)('opens the run comparison directly and marks affected tests for %s edits', async (_verdict) => {
    const review = vi.fn()
    const setCurrentTests = vi.fn()
    vi.mocked(getFeatureTests).mockResolvedValue([
      {
        file: '/tmp/runs/r1/suite/e2e/a.spec.ts',
        tests: [
          { name: 'a', line: 3, bodySource: '', steps: [], readable: readableTest('a') },
          { name: 'b', line: 12, bodySource: '', steps: [], readable: readableTest('b') },
        ],
      },
    ])
    vi.mocked(getTestSourceComparison).mockResolvedValue({ state: 'ready', files: ['e2e/a.spec.ts'], differences: [{ file: 'e2e/a.spec.ts', affectedTests: ['b'] }], changes: { added: [], changed: [{ file: 'e2e/a.spec.ts', name: 'b', line: 12, endLine: 15 }], removed: [] } })

    await act(async () => {
      root.render(
        <TestCasesColumn
          feature="alpha"
          activeRunSummary={undefined}
          activeRunStatus={undefined}
          baselineRun={{ runId: 'r1', featureDir: '/tmp/features/alpha', suiteSnapshot: { kind: 'taken', dir: '/tmp/runs/r1/suite', takenAt: 'now', digest: 'digest' } }}
          onCurrentTestsChange={setCurrentTests}
          onReviewTest={review}
        />,
      )
    })
    await waitFor(() => container.querySelector('[aria-label="Compare 1 changed tests"]') !== null)

    // The snapshot is the baseline, so only the test the run executed in a
    // different form is marked. Every classification still needs attention.
    const cardFor = (name: string) => {
      const button = Array.from(container.querySelectorAll('.cl-card > button')).find((el) => el.textContent?.includes(name))
      return button?.closest('.cl-card') as HTMLElement | null
    }
    expect(cardFor('b')?.querySelector('[data-testid="test-modified-dot"]')).not.toBeNull()
    expect(cardFor('a')?.querySelector('[data-testid="test-modified-dot"]')).toBeNull()
    // The drift mark IS the entrance to the comparison, and it sits in the column
    // header beside the tabs it qualifies. A ready comparison states its drift and
    // nothing else, so the unknown-comparison mark must be absent here.
    const compare = container.querySelector<HTMLButtonElement>('[aria-label="Compare 1 changed tests"]')!
    expect(compare.closest('.cl-panel-header')).not.toBeNull()
    expect(container.querySelector('[data-testid="test-version-compare"]')).toBeNull()
    await act(async () => compare.click())
    // Suite-relative, with the run baseline named — not the git-HEAD one, opened
    // at the test that drifted rather than at the top of the file.
    expect(review).toHaveBeenCalledWith('e2e/a.spec.ts', 12, 'run', 'changed', 'b')
    expect(document.querySelector('[role="menu"]')).toBeNull()

    await act(async () => { container.querySelector<HTMLButtonElement>('[aria-label="Test source"] button')!.click() })
    expect(setCurrentTests).toHaveBeenCalledWith(true)
  })

  it('leaves current source unlabelled without borrowing a run verdict or another file’s changes', async () => {
    vi.mocked(getFeatureTests).mockResolvedValue(['a', 'b'].map((file) => ({
      file: `/tmp/features/alpha/e2e/${file}.spec.ts`,
      tests: [{ name: 'same title', line: 3, bodySource: '', steps: [], readable: readableTest('same title') }],
    })))
    vi.mocked(getTestSourceComparison).mockResolvedValue({ state: 'ready', files: ['e2e/a.spec.ts', 'e2e/b.spec.ts'], differences: [{ file: 'e2e/b.spec.ts', affectedTests: ['same title'] }], changes: { added: [], changed: [], removed: [] } })
    await act(async () => root.render(<TestCasesColumn feature="alpha" currentTests
      activeRunSummary={undefined} activeRunStatus={undefined}
      baselineRun={{ runId: 'r1', featureDir: '/tmp/features/alpha', suiteSnapshot: { kind: 'taken', dir: '/tmp/runs/r1/suite', takenAt: 'now', digest: 'digest' } }} />))
    const cards = container.querySelectorAll('.cl-card')
    expect(container.querySelectorAll('.cl-card > button > span.uppercase')).toHaveLength(0)
    expect(cards[0].querySelector('[data-testid="test-modified-dot"]')).toBeNull()
    expect(cards[1].querySelector('[data-testid="test-modified-dot"]')).not.toBeNull()
  })

  it('highlights only the line(s) the server reports as changed for a dirty test', async () => {
    vi.mocked(getFeatureTests).mockResolvedValue([
      {
        file: '/tmp/features/alpha/e2e/a.spec.ts',
        tests: [
          { name: 'a', line: 3, bodySource: '{\n  const x = 1\n  expect(x).toBe(2)\n}', sourceChanges: { changedLines: [5], count: 1 }, steps: [], readable: readableTest('a') },
        ],
      },
    ])

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
      ;(container.querySelector('[data-testid="test-presentation-code-tab"]') as HTMLButtonElement).click()
    })
    await waitFor(() => Boolean(container.querySelector('[data-changed-line="true"]')))

    const changedLines = container.querySelectorAll('[data-changed-line="true"]')
    expect(changedLines).toHaveLength(1)
    expect(changedLines[0].textContent).toContain('toBe(2)')
    expect(changedLines[0].getAttribute('style')).toContain('var(--warning)')
    expect(getTestFileReview).not.toHaveBeenCalled()
  })

  it('renders an error when feature tests fail to load', async () => {
    vi.mocked(getFeatureTests).mockRejectedValue(new ApiError(500, { error: 'boom' }))

    await act(async () => {
      root.render(<TestCasesColumn feature="alpha" activeRunSummary={undefined} activeRunStatus={undefined} />)
    })

    expect(container.textContent).toContain('Unable to load tests for this suite. Server returned HTTP 500.')
    expect(container.querySelector('[data-testid="tests-loading-placeholder"]')).toBeNull()
  })

  it('does not render the evaluation export in the tests pane', async () => {
    vi.mocked(getFeatureTests).mockResolvedValue([])

    await act(async () => {
      root.render(<TestCasesColumn feature="alpha beta" activeRunSummary={undefined} activeRunStatus="passed" />)
    })

    expect(container.textContent).not.toContain('Evaluation')
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
      ;(container.querySelector('[data-testid="test-presentation-code-tab"]') as HTMLButtonElement).click()
    })

    expect(container.textContent).toContain("page.goto('/checkout')")
    expect(container.textContent).not.toContain('No test body available.')
  })

  // A heal edit moves a test to another line between cycles, and a targeted
  // rerun only re-lists the tests it re-runs — so the roster's recorded line is
  // allowed to be stale for a test that already passed. Matching by exact line
  // turned two real passes into "pending" (run 2026-09-04T0638-7rcl).
  it('keeps a passed verdict when a heal edit moved the test to another line', async () => {
    vi.mocked(getFeatureTests).mockResolvedValue([
      {
        file: '/tmp/features/alpha/e2e/current.spec.ts',
        tests: [{ name: 'validates checkout', line: 24, bodySource: '{}', steps: [], readable: readableTest('validates checkout') }],
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
              { id: 'test-id-checkout', name: 'test-case-validates-checkout', title: 'validates checkout', location: '/tmp/features/alpha/e2e/current.spec.ts:14' },
            ],
            failed: [],
          }}
        />,
      )
    })

    await waitFor(() => statusBadges().length > 0)
    expect(statusBadges()).toEqual(['passed'])
  })

  it('lets the line decide only when one file declares the same title twice', async () => {
    vi.mocked(getFeatureTests).mockResolvedValue([
      {
        file: '/tmp/features/alpha/e2e/current.spec.ts',
        tests: [
          { name: 'renders', line: 14, bodySource: '{}', steps: [], readable: readableTest('renders') },
          { name: 'renders', line: 30, bodySource: '{}', steps: [], readable: readableTest('renders') },
        ],
      },
    ])

    await act(async () => {
      root.render(
        <TestCasesColumn
          feature="alpha"
          activeRunStatus="failed"
          activeRunSummary={{
            complete: true,
            total: 2,
            passed: 1,
            passedNames: ['test-case-renders'],
            passedIds: ['id-guest'],
            knownTests: [
              { id: 'id-guest', name: 'test-case-renders', title: 'renders', location: '/tmp/features/alpha/e2e/current.spec.ts:14' },
              { id: 'id-host', name: 'test-case-renders', title: 'renders', location: '/tmp/features/alpha/e2e/current.spec.ts:30' },
            ],
            failed: [{ id: 'id-host', name: 'test-case-renders' }],
          }}
        />,
      )
    })

    await waitFor(() => statusBadges().length === 2)
    expect(statusBadges()).toEqual(['passed', 'failed'])
  })
})
