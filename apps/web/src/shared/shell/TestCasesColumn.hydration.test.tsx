// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, getFeatureDirtyDiff, getFeatureTests } from '../api/client'
import { readableTest } from '../api/__fixtures__/readable-test'
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

describe('TestCasesColumn', () => {
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
            readable: readableTest('retrieves a REJECTED record with reason populated'),
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

    const codeTab = container.querySelector<HTMLButtonElement>('[data-testid="test-presentation-code-tab"]')
    expect(codeTab).not.toBeNull()
    await act(async () => {
      codeTab?.click()
    })

    expect(container.textContent).toContain("page.goto('/line/rejected')")
    expect(container.textContent).not.toContain('No test body available.')
  })

  it('uses workspace tests for counts and run summary ids only for statuses', async () => {
    const specFile = '/tmp/features/alpha/e2e/current.spec.ts'
    const knownTests = Array.from({ length: 31 }, (_, idx) => ({
      id: `test-id-${idx + 1}`,
      name: `test-case-run-test-${idx + 1}`,
      title: `run test ${idx + 1}`,
      location: `${specFile}:${idx + 1}`,
    }))
    knownTests[5] = {
      id: 'test-id-duplicate-a',
      name: 'test-case-validates-duplicate',
      title: 'validates duplicate',
      location: `${specFile}:100`,
    }
    knownTests[6] = {
      id: 'test-id-duplicate-b',
      name: 'test-case-validates-duplicate',
      title: 'validates duplicate',
      location: `${specFile}:120`,
    }
    vi.mocked(getFeatureTests).mockResolvedValue([
      {
        file: specFile,
        tests: [
          ...knownTests.slice(0, 5).map((test, idx) => ({
            name: test.title,
            line: idx + 1,
            bodySource: '',
            steps: [],
            readable: readableTest(test.title),
          })),
          { name: 'validates duplicate', line: 100, bodySource: '', steps: [], readable: readableTest('validates duplicate') },
          { name: 'validates duplicate', line: 120, bodySource: '', steps: [], readable: readableTest('validates duplicate') },
          ...knownTests.slice(7, 31).map((test, idx) => ({
            name: test.title,
            line: idx + 8,
            bodySource: '',
            steps: [],
            readable: readableTest(test.title),
          })),
          { name: 'workspace-only test 32', line: 132, bodySource: '', steps: [], readable: readableTest('workspace-only test 32') },
          { name: 'workspace-only test 33', line: 133, bodySource: '', steps: [], readable: readableTest('workspace-only test 33') },
        ],
      },
    ])

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

    expect(container.textContent).toContain('12/33')
    expect(container.textContent).not.toContain('12/31')
    expect(container.textContent).toContain('workspace-only test 33')
    expect(container.textContent).toContain('validates duplicate')
    expect(container.querySelectorAll('.border-success\\/40')).toHaveLength(12)
  })
})
