import { useCallback, useEffect, useRef, useState, type DragEvent, type JSX } from 'react'
import * as api from '../../../shared/api/client'
import type { FeatureDocsListing } from '../../../shared/api/types'

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = String(reader.result)
      const comma = result.indexOf(',')
      resolve(comma >= 0 ? result.slice(comma + 1) : result)
    }
    reader.onerror = () => reject(reader.error ?? new Error('read failed'))
    reader.readAsDataURL(file)
  })
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

interface Props {
  feature: string
  open: boolean
  onToggle: () => void
  generating: boolean
  summaryAbsent: boolean // ledger.state.summary === 'absent'
  summaryStale: boolean // ledger.state.summary === 'stale'
  coverageActionable: boolean // ledger.state.summary === 'fresh'
  drift: { changedDocs: string[]; affectedArtifacts: string[] } | null
  onGenerate: (kind: 'summary' | 'coverage') => void
  onDocsChanged: () => void // call after a successful import/delete/clear so the parent refetches
  /** Bumped by the parent when a generation job completes — the generated
   *  _prd-summary.md now exists, so re-list the docs (items 1+2: the pill must
   *  appear live, without a manual refresh). */
  reloadKey?: number
}

// CoverageDocsRail — a collapsible LEFT RAIL that owns ONLY source-doc CRUD for a
// feature (list / import / delete / clear the generated PRD artifact). The parent
// (CoverageLedgerPage) owns the generation job lifecycle; this rail merely fires
// onGenerate callbacks and never polls jobs or holds any job state. Wired to the
// SAME REST endpoints the MCP tools use so UI and agents stay in sync.
export function CoverageDocsRail(props: Props): JSX.Element {
  const { feature, open, onToggle, generating, summaryAbsent, summaryStale, coverageActionable, drift, onGenerate, onDocsChanged, reloadKey } = props

  const [listing, setListing] = useState<FeatureDocsListing | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // `keepError` lets a refetch that follows a partially-failed batch import
  // preserve the combined error message instead of clearing it on success.
  const load = useCallback((keepError = false) => {
    api.listFeatureDocs(feature)
      .then((data) => { setListing(data); if (!keepError) setError(null) })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }, [feature])

  // Re-list on mount, on feature change, and whenever the parent bumps reloadKey
  // (a generation job completed → the generated PRD artifact now exists).
  useEffect(() => { load() }, [load, reloadKey])

  // Import each file SEQUENTIALLY — the md-only extractor + single-flight summary
  // job must not be hammered concurrently. A per-file failure does not abort the
  // batch: we record it, keep going, and surface a combined error at the end.
  const importFiles = useCallback(async (files: File[] | FileList) => {
    const list = Array.from(files)
    if (list.length === 0) return
    setBusy(true)
    setError(null)
    const failures: string[] = []
    let imported = 0
    for (const file of list) {
      try {
        const base64 = await readAsBase64(file)
        await api.importFeatureDoc(feature, { filename: file.name, contentType: file.type || undefined, base64 })
        imported += 1
      } catch (e: unknown) {
        failures.push(`${file.name} (${e instanceof Error ? e.message : String(e)})`)
      }
    }
    if (failures.length > 0) {
      setError(`${failures.length} of ${list.length} docs failed: ${failures.join(', ')}`)
    }
    if (imported > 0) {
      load(failures.length > 0)
      onDocsChanged()
    }
    setBusy(false)
  }, [feature, load, onDocsChanged])

  const removeDoc = useCallback((relPath: string) => {
    setBusy(true)
    api.deleteFeatureDoc(feature, relPath)
      .then(() => { load(); onDocsChanged() })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false))
  }, [feature, load, onDocsChanged])

  // Open a doc in the user's configured editor (same launcher the run/test views
  // use). Best-effort — surface a failure in the docs error slot.
  const openDoc = useCallback((absPath: string) => {
    api.openEditor({ file: absPath })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Failed to open in editor'))
  }, [])

  // "Redo from the start" — a full reset to a blank slate: drop the generated PRD
  // summary + coverage AND every uploaded source doc, returning to the empty
  // "Add source docs" dropzone. Destructive, so it's behind an inline confirm.
  const [confirmingRedo, setConfirmingRedo] = useState(false)
  const redoFromStart = useCallback(async () => {
    setConfirmingRedo(false)
    setBusy(true)
    setError(null)
    const failures: string[] = []
    try {
      try { await api.clearPrdSummary(feature) } catch (e) { failures.push(`summary (${e instanceof Error ? e.message : String(e)})`) }
      for (const d of listing?.docs ?? []) {
        if (d.generated) continue // already removed by clearPrdSummary
        try { await api.deleteFeatureDoc(feature, d.relPath) } catch (e) { failures.push(`${d.relPath} (${e instanceof Error ? e.message : String(e)})`) }
      }
    } finally {
      if (failures.length) setError(`Reset incomplete: ${failures.join(', ')}`)
      load(failures.length > 0)
      onDocsChanged()
      setBusy(false)
    }
  }, [feature, listing, load, onDocsChanged])

  // Doc add/remove are state-changing — lock them while a generation job runs
  // (the job reads the current docs); only the always-safe Close stays live.
  const locked = busy || generating
  // Once a PRD summary exists the source set is FROZEN against the generated
  // ledger: silently adding/removing docs would desync the coverage mapping. The
  // only way to change docs is "Redo from the start", which re-runs the whole
  // exercise. (Opening a doc in the editor stays available — it's read-only.)
  const docsFrozen = !summaryAbsent
  const docsLocked = locked || docsFrozen
  // Hide (not just disable) the remove ✕ + "Add docs" affordances whenever the
  // docs are frozen (a summary exists) OR a job is running — during generation
  // the agent is reading the current docs, so mutating them is never valid.
  const docsReadOnly = docsFrozen || generating

  const onDrop = useCallback((e: DragEvent) => {
    e.preventDefault()
    setDragging(false)
    if (locked || docsFrozen) return
    const files = e.dataTransfer.files
    if (files && files.length > 0) void importFiles(files)
  }, [importFiles, locked, docsFrozen])

  const sourceCount = listing?.sourceDocCount ?? 0
  const dirPrefix = `features/${feature}/docs/`

  // ── Collapsed: a thin full-height strip that toggles open ──────────────────
  if (!open) {
    return (
      <div
        data-testid="docs-rail"
        className="flex h-full min-h-0 flex-col"
        style={{ width: 46, borderRight: '1px solid var(--border-default)', background: 'var(--bg-surface)' }}
      >
        <button
          type="button"
          data-testid="docs-rail-toggle"
          onClick={onToggle}
          title="Show source docs"
          aria-label="Show source docs"
          className="flex h-full w-full flex-col items-center gap-3"
          style={{
            padding: '14px 0', background: 'transparent', border: 'none', cursor: 'pointer',
            color: 'var(--text-secondary)', transition: 'background 140ms, color 140ms',
          }}
        >
          <span aria-hidden="true" className="flex h-7 w-7 items-center justify-center">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <path d="M14 2v6h6" />
            </svg>
          </span>
          <span
            data-testid="docs-rail-count"
            className="flex h-5 w-5 items-center justify-center rounded-full"
            style={{
              fontSize: 11, fontFamily: 'var(--font-mono, monospace)', color: 'var(--text-primary)',
              background: 'color-mix(in srgb, var(--text-muted) 16%, transparent)',
            }}
          >
            {sourceCount}
          </span>
          <span aria-hidden="true" style={{ marginTop: 'auto', color: 'var(--text-muted)' }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 18l6-6-6-6" />
            </svg>
          </span>
        </button>
      </div>
    )
  }

  // ── Open: a ~320px full-height panel, scrollable ───────────────────────────
  return (
    <div
      data-testid="docs-rail"
      className="flex h-full min-h-0 flex-col"
      style={{
        width: 320, flexShrink: 0, borderRight: '1px solid var(--border-default)',
        background: 'var(--bg-surface)', position: 'relative',
        transition: 'width 140ms ease',
      }}
      onDragOver={(e) => { e.preventDefault(); if (docsFrozen || locked) return; if (!dragging) setDragging(true) }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setDragging(false) }}
      onDrop={onDrop}
    >
      <input
        ref={fileInputRef}
        data-testid="doc-file-input"
        type="file"
        multiple
        accept=".md,.markdown,.txt,.pdf,.docx"
        style={{ display: 'none' }}
        onChange={(e) => {
          const files = e.target.files
          if (files && files.length > 0) void importFiles(files)
          e.target.value = ''
        }}
      />

      {/* Header */}
      <div
        className="flex items-center gap-2"
        style={{ padding: '12px 14px', borderBottom: '1px solid var(--border-default)' }}
      >
        <h2 style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>Source docs</h2>
        <button
          type="button"
          data-testid="docs-rail-toggle"
          onClick={onToggle}
          title="Collapse source docs"
          aria-label="Collapse source docs"
          className="cl-icon-button ml-auto h-7 w-7 shrink-0"
          style={{ color: 'var(--text-muted)' }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </button>
      </div>

      {/* Scrollable body */}
      <div className="min-h-0 flex-1 overflow-auto" style={{ padding: '12px 14px' }}>
        {/* Status line */}
        {summaryAbsent && (
          <div
            data-testid="docs-rail-drift"
            style={{
              fontSize: 11, color: 'var(--text-muted)', marginBottom: 12,
              border: '1px solid var(--border-default)', borderRadius: 999, padding: '3px 10px',
              display: 'inline-block',
            }}
          >
            No PRD summary yet
          </div>
        )}
        {!summaryAbsent && summaryStale && drift && (
          <div
            data-testid="docs-rail-drift"
            style={{
              fontSize: 11, color: 'rgb(251, 191, 36)', lineHeight: 1.45, marginBottom: 12,
              border: '1px solid rgb(251,191,36)', borderRadius: 'var(--radius-md)', padding: '6px 10px',
            }}
          >
            <span style={{ fontFamily: 'var(--font-mono, monospace)' }}>{drift.changedDocs.join(', ')}</span>
            {' '}changed → affects {drift.affectedArtifacts.join(' + ')}
          </div>
        )}

        {error && (
          <div data-testid="docs-error" style={{ color: 'rgb(251, 113, 133)', fontSize: 11.5, lineHeight: 1.45, marginBottom: 12 }}>
            {error}
          </div>
        )}

        {/* Doc pills + add affordances */}
        {listing && (
          listing.docs.length === 0 ? (
            <EmptyDropzone onPick={() => fileInputRef.current?.click()} dragging={dragging} busy={locked} />
          ) : (
            <div className="flex flex-col" style={{ gap: 8 }}>
              {listing.docs.map((d) => (
                <DocPill
                  key={d.relPath}
                  relPath={d.relPath}
                  dirPrefix={dirPrefix}
                  generated={d.generated}
                  sizeBytes={d.sizeBytes}
                  busy={locked}
                  onOpen={() => openDoc(d.absPath)}
                  onRemove={docsReadOnly ? undefined : () => removeDoc(d.relPath)}
                  removeTitle="Remove source doc"
                />
              ))}
              {!docsReadOnly && (
                <button
                  type="button"
                  data-testid="add-another-doc"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={locked}
                  className="flex w-full items-center justify-center gap-2"
                  style={{
                    padding: '10px 12px', borderRadius: 'var(--radius-md)',
                    border: '1px dashed var(--border-default)', background: 'transparent',
                    color: 'var(--text-muted)', cursor: 'pointer', fontSize: 11.5,
                  }}
                >
                  <span aria-hidden="true" style={{ fontSize: 13, lineHeight: 1 }}>+</span>
                  Add docs — drop files or click to browse
                </button>
              )}
            </div>
          )
        )}
      </div>

      {/* Footer generate actions (sticky bottom) */}
      <div
        className="flex flex-col"
        style={{ gap: 8, padding: '12px 14px', borderTop: '1px solid var(--border-default)', background: 'var(--bg-surface)' }}
      >
        {summaryAbsent ? (
          <button
            type="button"
            data-testid="generate-summary"
            onClick={() => onGenerate('summary')}
            disabled={generating || sourceCount === 0}
            className="cl-button w-full px-3 py-1.5"
            title={sourceCount === 0 ? 'Add a source doc first' : 'Generate the PRD summary from these docs'}
            style={!generating && sourceCount > 0
              ? { background: 'var(--accent)', color: '#0b0f17', borderColor: 'var(--accent)', fontWeight: 600 }
              : undefined}
          >
            {generating ? 'Generating…' : 'Generate'}
          </button>
        ) : confirmingRedo ? (
          <>
            <div style={{ fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.45, marginBottom: 2 }}>
              Delete the generated summary <strong style={{ color: 'var(--text-primary)' }}>and all source docs</strong>, and strip the <strong style={{ color: 'var(--text-primary)' }}>@req-/@path- tags</strong> from your specs? You&apos;ll start over from an empty doc list.
            </div>
            <button
              type="button"
              data-testid="confirm-redo"
              onClick={() => void redoFromStart()}
              disabled={locked}
              className="cl-button w-full px-3 py-1.5"
              style={{ background: 'rgb(251, 113, 133)', color: '#0b0f17', borderColor: 'rgb(251, 113, 133)', fontWeight: 600 }}
            >
              Wipe everything &amp; start over
            </button>
            <button
              type="button"
              data-testid="cancel-redo"
              onClick={() => setConfirmingRedo(false)}
              disabled={locked}
              className="cl-button w-full px-3 py-1.5"
            >
              Cancel
            </button>
          </>
        ) : (
          <button
            type="button"
            data-testid="redo-from-start"
            onClick={() => setConfirmingRedo(true)}
            disabled={locked}
            className="cl-button w-full px-3 py-1.5"
            title="Delete the summary + all source docs and start over from scratch"
          >
            {generating ? 'Generating…' : 'Redo from the start'}
          </button>
        )}
      </div>

      {/* Full-rail drag overlay */}
      {dragging && (
        <div
          data-testid="drop-overlay"
          className="pointer-events-none absolute inset-0 flex items-center justify-center"
          style={{ background: 'color-mix(in srgb, var(--accent) 10%, transparent)', border: '2px dashed var(--accent)', borderRadius: 'var(--radius-md)' }}
        >
          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--accent)' }}>Drop to add source docs</span>
        </div>
      )}
    </div>
  )
}

function DocPill({ relPath, dirPrefix, generated, sizeBytes, busy, onOpen, onRemove, removeTitle }: {
  relPath: string
  dirPrefix: string
  generated: boolean
  sizeBytes: number
  busy: boolean
  onOpen: () => void
  /** Omitted when the doc set is frozen (a summary exists) — the pill is read-only. */
  onRemove?: () => void
  removeTitle: string
}) {
  const [hover, setHover] = useState(false)
  return (
    <div
      data-testid={`doc-pill-${relPath}`}
      className="flex items-center gap-2.5"
      onClick={onOpen}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen() } }}
      title={`Open ${dirPrefix}${relPath} in editor`}
      style={{
        padding: '9px 11px',
        borderRadius: 'var(--radius-md)',
        background: hover ? 'var(--bg-selected)' : 'var(--bg-base)',
        border: `1px solid ${hover ? 'color-mix(in srgb, var(--text-muted) 38%, var(--border-default))' : 'var(--border-default)'}`,
        cursor: 'pointer',
        transition: 'background 120ms, border-color 120ms',
      }}
    >
      <span
        aria-hidden="true"
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded"
        style={{
          background: 'color-mix(in srgb, var(--text-muted) 12%, transparent)',
          color: generated ? 'rgb(56,189,248)' : 'var(--text-secondary)',
        }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <path d="M14 2v6h6" />
        </svg>
      </span>
      <div className="min-w-0 flex-1">
        <div style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 12, lineHeight: 1.3 }} className="truncate" title={`${dirPrefix}${relPath}`}>
          <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{relPath}</span>
        </div>
        <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>
          {generated ? 'Generated PRD artifact' : 'Source doc'} · {formatBytes(sizeBytes)}
        </div>
      </div>
      {onRemove && (
        <button
          type="button"
          data-testid={`remove-doc-${relPath}`}
          onClick={(e) => { e.stopPropagation(); onRemove() }}
          disabled={busy}
          aria-label={`Remove ${relPath}`}
          title={removeTitle}
          className="cl-icon-button h-6 w-6 shrink-0"
          style={{ color: 'var(--text-muted)' }}
        >
          ✕
        </button>
      )}
    </div>
  )
}

function EmptyDropzone({ onPick, dragging, busy }: { onPick: () => void; dragging: boolean; busy: boolean }) {
  return (
    <button
      type="button"
      data-testid="empty-dropzone"
      onClick={onPick}
      disabled={busy}
      className="flex w-full flex-col items-center justify-center gap-2 text-center"
      style={{
        padding: '34px 16px',
        borderRadius: 'var(--radius-md)',
        border: `2px dashed ${dragging ? 'var(--accent)' : 'var(--border-default)'}`,
        background: dragging ? 'color-mix(in srgb, var(--accent) 8%, transparent)' : 'var(--bg-base)',
        cursor: 'pointer',
        transition: 'border-color 150ms, background 150ms',
      }}
    >
      <span
        aria-hidden="true"
        className="flex h-10 w-10 items-center justify-center rounded-full"
        style={{ background: 'color-mix(in srgb, var(--accent) 12%, transparent)', color: 'var(--accent)' }}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 5v14M5 12h14" />
        </svg>
      </span>
      <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-primary)' }}>Add source docs</span>
      <span style={{ fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.45 }}>
        Drop spec, ticket, or notes files here — or click to browse. Accepts <code>.md</code>, <code>.txt</code>, <code>.pdf</code>, <code>.docx</code>.
      </span>
    </button>
  )
}
