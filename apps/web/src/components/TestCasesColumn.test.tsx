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

  it('renders an error when feature tests fail to load', async () => {
    vi.mocked(getFeatureTests).mockRejectedValue(new ApiError(500, { error: 'boom' }))

    await act(async () => {
      root.render(<TestCasesColumn feature="alpha" activeRunSummary={undefined} activeRunStatus={undefined} />)
    })

    expect(container.textContent).toContain('Unable to load tests for this feature. Server returned HTTP 500.')
    expect(container.textContent).not.toContain('Loading...')
  })

  it('does not render the assertion export in the tests pane', async () => {
    vi.mocked(getFeatureTests).mockResolvedValue([])

    await act(async () => {
      root.render(<TestCasesColumn feature="alpha beta" activeRunSummary={undefined} activeRunStatus="passed" />)
    })

    expect(container.textContent).not.toContain('Export Assertion')
  })
})
