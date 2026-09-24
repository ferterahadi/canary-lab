// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { TestReviewBanner } from './TestReviewBanner'

it('makes the next action visible without a hover and opens review instead of adopting tests', () => {
  const host = document.createElement('div')
  const root = createRoot(host)
  const review = vi.fn()
  try {
    act(() => root.render(<TestReviewBanner count={1} onReview={review} />))
    expect(host.textContent).toContain('1 test file changed after this run started')
    expect(host.textContent).toContain('previous test version')
    expect(host.querySelector('button')?.textContent).toBe('Review test changes →')
    act(() => host.querySelector('button')!.click())
    expect(review).toHaveBeenCalledOnce()
  } finally { act(() => root.unmount()) }
})
