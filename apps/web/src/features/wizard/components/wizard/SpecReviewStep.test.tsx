import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { SpecReviewStep } from './SpecReviewStep'
import type { DraftRecord } from '../../../../shared/api/types'

function draft(overrides: Partial<DraftRecord> = {}): DraftRecord {
  return {
    draftId: 'd1',
    prdText: 'Login flow',
    prdDocuments: [],
    repos: [{ name: 'app', localPath: '/repo' }],
    featureName: 'login_flow',
    status: 'spec-ready',
    createdAt: '2026-05-06T00:00:00.000Z',
    updatedAt: '2026-05-06T00:00:00.000Z',
    generatedFiles: [
      'feature.config.cjs',
      'playwright.config.ts',
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
    expect(html).not.toContain('playwright.config.ts')
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

  it('disables reject while spec generation is still running', () => {
    const html = renderToStaticMarkup(
      <SpecReviewStep
        draft={draft({ status: 'generating' })}
        featureName="login_flow"
        onAccept={vi.fn()}
        onReject={vi.fn()}
        onRetry={vi.fn()}
        onCancelGeneration={vi.fn()}
        acting={false}
      />,
    )

    const reject = buttonByText(html, 'Reject')
    expect(reject?.hasAttribute('disabled')).toBe(true)
    expect(reject?.className).toContain('disabled:cursor-not-allowed')
    expect(html).toContain('overflow-hidden p-6')
    expect(html).toContain('flex min-h-0 flex-1 flex-col overflow-hidden')
    expect(html).not.toContain('max-h-[min(70vh,44rem)]')
  })

  it('keeps cancelled spec output bounded in a scrollable body', () => {
    const html = renderToStaticMarkup(
      <SpecReviewStep
        draft={draft({ status: 'cancelled' })}
        featureName="login_flow"
        onAccept={vi.fn()}
        onReject={vi.fn()}
        onRetry={vi.fn()}
        onCancelGeneration={vi.fn()}
        acting={false}
      />,
    )

    expect(html).toContain('overflow-y-auto p-6')
    expect(html).toContain('max-h-[min(70vh,44rem)]')
    expect(html).toContain('min-h-[24rem]')
  })

  it('leaves reject enabled once spec files are ready', () => {
    const html = renderToStaticMarkup(
      <SpecReviewStep
        draft={draft({ status: 'spec-ready' })}
        featureName="login_flow"
        onAccept={vi.fn()}
        onReject={vi.fn()}
        onRetry={vi.fn()}
        onCancelGeneration={vi.fn()}
        acting={false}
      />,
    )

    const reject = buttonByText(html, 'Reject')
    expect(reject?.hasAttribute('disabled')).toBe(false)
  })
})

function buttonByText(html: string, text: string): HTMLButtonElement | null {
  const button = html
    .match(/<button\b[^>]*>[\s\S]*?<\/button>/g)
    ?.find((candidate) => candidate.replace(/<[^>]+>/g, '').trim() === text)
  if (!button) return null
  return {
    className: button.match(/\bclass="([^"]*)"/)?.[1] ?? '',
    hasAttribute: (name: string) => new RegExp(`\\s${name}(?:=|\\s|>)`).test(button),
  } as HTMLButtonElement
}
