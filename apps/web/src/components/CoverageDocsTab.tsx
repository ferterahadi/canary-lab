import { useCallback, useEffect, useState } from 'react'
import * as api from '../api/client'
import type { FeatureDocsListing } from '../api/types'

interface Props {
  feature: string
  /** Called after a successful regenerate so the ledger view can re-fetch. */
  onRegenerated: () => void
}

// The Docs tab: the source material the PRD summary is built from. Pills for each
// docs/ file (source vs generated _prd-*), a drift indicator, and a regenerate
// action. All wired to the SAME REST endpoints the MCP tools use
// (`list_feature_docs` / `regenerate_prd_summary`) so UI and agents stay in sync.
export function CoverageDocsTab({ feature, onRegenerated }: Props) {
  const [listing, setListing] = useState<FeatureDocsListing | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [newRelPath, setNewRelPath] = useState('')
  const [newContent, setNewContent] = useState('')

  const load = useCallback(() => {
    setLoading(true)
    api.listFeatureDocs(feature)
      .then((data) => { setListing(data); setError(null) })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false))
  }, [feature])

  useEffect(() => { load() }, [load])

  const regenerate = useCallback(() => {
    setBusy(true)
    api.regeneratePrdSummary(feature)
      .then(() => { load(); onRegenerated() })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false))
  }, [feature, load, onRegenerated])

  const addDoc = useCallback(() => {
    const relPath = newRelPath.trim()
    if (!relPath || !newContent.trim()) return
    setBusy(true)
    api.writeFeatureDoc(feature, relPath, newContent)
      .then(() => { setNewRelPath(''); setNewContent(''); setAdding(false); load() })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false))
  }, [feature, newRelPath, newContent, load])

  return (
    <div className="min-h-0 flex-1 overflow-auto p-5" data-testid="coverage-docs-tab">
      {loading && <div style={{ color: 'var(--text-secondary)' }}>Loading docs…</div>}
      {error && <div style={{ color: 'rgb(251, 113, 133)' }}>{error}</div>}
      {!loading && listing && (
        <>
          <div className="flex items-center gap-3" style={{ marginBottom: 14 }}>
            <h2 style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>Source docs</h2>
            {listing.docsDrift && (
              <span
                data-testid="docs-tab-drift"
                style={{ fontSize: 12, color: 'rgb(251, 191, 36)', border: '1px solid rgb(251,191,36)', borderRadius: 'var(--radius-md)', padding: '2px 8px' }}
              >
                {listing.hasPrdSummary ? 'Docs changed since last summary' : 'No PRD summary yet'}
              </span>
            )}
            <button
              type="button"
              data-testid="add-doc-toggle"
              onClick={() => setAdding((v) => !v)}
              disabled={busy}
              className="cl-button ml-auto px-3 py-1.5"
            >
              {adding ? 'Cancel' : 'Add doc'}
            </button>
            <button
              type="button"
              data-testid="regenerate-prd"
              onClick={regenerate}
              disabled={busy || listing.sourceDocCount === 0}
              className="cl-button px-3 py-1.5"
              title={listing.sourceDocCount === 0 ? 'Add a source doc first' : 'Regenerate the PRD summary (preserves requirement ids)'}
            >
              {busy ? 'Regenerating…' : 'Regenerate PRD summary'}
            </button>
          </div>

          {adding && (
            <div data-testid="add-doc-form" style={{ marginBottom: 16, padding: 12, border: '1px solid var(--border-default)', borderRadius: 'var(--radius-md)', background: 'var(--bg-surface)' }}>
              <input
                data-testid="add-doc-relpath"
                value={newRelPath}
                onChange={(e) => setNewRelPath(e.target.value)}
                placeholder="relative path, e.g. spec.md"
                style={{ width: '100%', marginBottom: 8, padding: '6px 8px', fontSize: 13, background: 'var(--bg-base)', border: '1px solid var(--border-default)', borderRadius: 'var(--radius-sm, 4px)', color: 'var(--text-primary)' }}
              />
              <textarea
                data-testid="add-doc-content"
                value={newContent}
                onChange={(e) => setNewContent(e.target.value)}
                placeholder="# Markdown content"
                rows={6}
                style={{ width: '100%', marginBottom: 8, padding: '6px 8px', fontSize: 13, fontFamily: 'var(--font-mono, monospace)', background: 'var(--bg-base)', border: '1px solid var(--border-default)', borderRadius: 'var(--radius-sm, 4px)', color: 'var(--text-primary)' }}
              />
              <button
                type="button"
                data-testid="add-doc-save"
                onClick={addDoc}
                disabled={busy || !newRelPath.trim() || !newContent.trim()}
                className="cl-button px-3 py-1.5"
              >
                Save doc
              </button>
            </div>
          )}

          <div className="flex flex-wrap gap-2" style={{ marginBottom: 18 }}>
            {listing.docs.length === 0 && (
              <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>
                No docs yet. Add markdown to <code>features/{feature}/docs/</code> (via the MCP <code>write_feature_doc</code> tool or directly), then regenerate.
              </span>
            )}
            {listing.docs.map((d) => (
              <span
                key={d.relPath}
                data-testid={`doc-pill-${d.relPath}`}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                  fontSize: 12, padding: '4px 10px', borderRadius: 'var(--radius-md)',
                  background: 'var(--bg-surface)',
                  border: `1px solid ${d.generated ? 'rgb(56,189,248)' : 'var(--border-default)'}`,
                  color: 'var(--text-primary)',
                }}
                title={d.generated ? 'Generated PRD artifact' : 'Source doc'}
              >
                {d.generated && <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'rgb(56,189,248)' }} />}
                {d.relPath}
              </span>
            ))}
          </div>

          {listing.prdSummaryGeneratedAt && (
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              PRD summary generated {new Date(listing.prdSummaryGeneratedAt).toLocaleString()}.
              Regeneration preserves existing requirement ids so inline <code>@requirement</code> annotations keep resolving.
            </div>
          )}
        </>
      )}
    </div>
  )
}
