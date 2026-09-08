export function TestReviewBanner({ count, onReview }: { count: number; onReview: () => void }) {
  return (
    <div className="mt-3 rounded-md border p-3 text-xs" data-testid="test-review-banner" style={{ borderColor: 'color-mix(in srgb, var(--warning) 45%, var(--border-default))', background: 'color-mix(in srgb, var(--warning) 6%, var(--bg-surface))' }}>
      <div className="font-medium" style={{ color: 'var(--text-primary)' }}>{count} test file{count === 1 ? '' : 's'} changed after this run started.</div>
      <p className="mt-1 mb-2" style={{ color: 'var(--text-secondary)' }}>Review the changes to continue. The results shown still come from the previous test version. Saving or merging source changes does not update this run. Adopt &amp; rerun applies the reviewed tests and executes them.</p>
      <button type="button" className="cl-button-primary px-3 py-1.5 text-xs" onClick={onReview}>Review test changes →</button>
    </div>
  )
}
