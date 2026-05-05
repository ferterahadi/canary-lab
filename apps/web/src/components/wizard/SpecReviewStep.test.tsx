import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { SpecReviewStep } from './SpecReviewStep'
import type { DraftRecord } from '../../api/types'

function draft(overrides: Partial<DraftRecord> = {}): DraftRecord {
  return {
    draftId: 'd1',
    prdText: 'Login flow',
    prdDocuments: [],
    repos: [{ name: 'app', localPath: '/repo' }],
    skills: [],
    featureName: 'login_flow',
    status: 'spec-ready',
    createdAt: '2026-05-06T00:00:00.000Z',
    updatedAt: '2026-05-06T00:00:00.000Z',
    generatedFiles: [
      'feature.config.cjs',
      'playwright.config.cjs',
      'envsets/envsets.config.json',
      'e2e/login.spec.ts',
      'e2e/login-helper.ts',
      'e2e/logout.spec.ts',
    ],
    ...overrides,
  }
}

describe('SpecReviewStep', () => {
  it('shows only generated spec files in the review list', () => {
    const html = renderToStaticMarkup(
      <SpecReviewStep
        draft={draft()}
        featureName="login_flow"
        onAccept={vi.fn()}
        onReject={vi.fn()}
        onRetry={vi.fn()}
        onCancelGeneration={vi.fn()}
        acting={false}
      />,
    )

    expect(html).toContain('features/login_flow/e2e/login.spec.ts')
    expect(html).toContain('features/login_flow/e2e/logout.spec.ts')
    expect(html).not.toContain('feature.config.cjs')
    expect(html).not.toContain('playwright.config.cjs')
    expect(html).not.toContain('envsets.config.json')
    expect(html).not.toContain('login-helper.ts')
  })

  it('does not render the agent output disclosure or refinement prompt', () => {
    const html = renderToStaticMarkup(
      <SpecReviewStep
        draft={draft()}
        featureName="login_flow"
        onAccept={vi.fn()}
        onReject={vi.fn()}
        onRetry={vi.fn()}
        onCancelGeneration={vi.fn()}
        acting={false}
      />,
    )

    expect(html).not.toContain('Agent output')
    expect(html).not.toContain('Suggest an adjustment')
  })
})
