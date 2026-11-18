import { plural } from '@shared/lib/plural'
export function TestReviewBanner({ count, onReview }: { count: number; onReview: () => void }) {
  return (
    <div className="mt-3 rounded-md border p-3 text-xs" data-testid="test-review-banner" style={{ borderColor: 'color-mix(in srgb, var(--warning) 45%, var(--border-default))', background: 'color-mix(in srgb, var(--warning) 6%, var(--bg-surface))' }}>
      <div className="font-medium" style={{ color: 'var(--text-primary)' }}>{plural(count, 'test file')} changed after this run started.</div>
      <p className="mt-1 mb-2" style={{ color: 'var(--text-secondary)' }}>Results use the previous test version. Review the edits before adopting and rerunning them.</p>
      <button type="button" className="cl-button-primary px-3 py-1.5 text-xs" onClick={onReview}>Review test changes →</button>
    </div>
  )
}
