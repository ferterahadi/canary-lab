// Stable per-test id badge (`#N`), rendered identically in every view so a
// person can cross-reference the same test across the Tests column, Playback,
// and the Coverage Ledger. The number comes from `buildTestNumbering`
// (see ../test-numbering.ts) — it is a source-order identity, not a row index.

export function TestIdBadge({ n }: { n: number | undefined }) {
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return null
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center"
      title={`Test #${n}`}
      style={{
        minWidth: '1.375rem',
        height: '1.125rem',
        padding: '0 0.375rem',
        borderRadius: 5,
        background: 'var(--bg-selected)',
        color: 'var(--text-secondary)',
        fontFamily: 'var(--font-mono)',
        fontSize: 10.5,
      }}
    >
      #{n}
    </span>
  )
}
