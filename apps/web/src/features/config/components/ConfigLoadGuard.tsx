// What a config tab shows before its document is usable: the read's error in
// the danger hue, or a muted "Loading…". Each tab keeps its own conditions so
// TypeScript still narrows the document it renders once past them.
export function ConfigLoadGuard({ error }: { error?: string }) {
  return (
    <div className="p-4 text-xs" style={{ color: error === undefined ? 'var(--text-muted)' : 'var(--danger)' }}>
      {error ?? 'Loading…'}
    </div>
  )
}
