import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { PlanReviewStep } from './PlanReviewStep'
import type { DraftRecord } from '../../api/types'

function draft(overrides: Partial<DraftRecord> = {}): DraftRecord {
  return {
    draftId: 'd1',
    prdText: 'Login flow',
    prdDocuments: [],
    repos: [{ name: 'app', localPath: '/repo' }],
    skills: [],
    featureName: 'login_flow',
    status: 'planning',
    createdAt: '2026-05-06T00:00:00.000Z',
    updatedAt: '2026-05-06T00:00:00.000Z',
    plan: [{ step: 'Login', actions: ['Open login'], expectedOutcome: 'User signs in' }],
    ...overrides,
  }
}

describe('PlanReviewStep', () => {
  it('uses a non-scrolling fill layout while plan generation is running', () => {
    const html = renderToStaticMarkup(
      <PlanReviewStep
        draft={draft({ status: 'planning' })}
        onAccept={vi.fn()}
        onReject={vi.fn()}
        onRetry={vi.fn()}
        onCancelGeneration={vi.fn()}
        acting={false}
      />,
    )

    expect(html).toContain('overflow-hidden p-6')
    expect(html).toContain('flex h-full min-h-0 flex-1 flex-col overflow-hidden')
    expect(html).not.toContain('max-h-[min(70vh,44rem)]')
  })

  it('keeps cancelled plan output bounded in a scrollable body', () => {
    const html = renderToStaticMarkup(
      <PlanReviewStep
        draft={draft({ status: 'cancelled' })}
        onAccept={vi.fn()}
        onReject={vi.fn()}
        onRetry={vi.fn()}
        onCancelGeneration={vi.fn()}
        acting={false}
      />,
    )

    expect(html).toContain('overflow-y-auto p-6')
    expect(html).toContain('max-h-[min(70vh,44rem)]')
    expect(html).toContain('h-[min(52vh,34rem)]')
  })
})
