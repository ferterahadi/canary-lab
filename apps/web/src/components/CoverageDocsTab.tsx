import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react'
import * as api from '../api/client'
import type { FeatureDocsListing } from '../api/types'

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
  /** Called after a successful regenerate so the ledger view can re-fetch. */
  onRegenerated: () => void
  /** Called after the doc set changes (upload/delete) so the setup guide's
   *  step ② can unlock without leaving the dialog. */
  onDocsChanged?: () => void
}

// The Docs tab: the source material the PRD summary is built from, shown as a
// centered column of generous file cards (path-first). Source docs are uploaded
// (.md/.txt/.pdf/.docx, extracted to markdown) or dropped onto the page; the
// generated `_prd-*` artifacts are shown read-only. Wired to the SAME REST
// endpoints the MCP tools use so UI and agents stay in sync.
export function CoverageDocsTab({ feature, onRegenerated, onDocsChanged }: Props) {
  const [listing, setListing] = useState<FeatureDocsListing | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  // Async summary generation streams its agent log here (matches the setup guide),
  // so "Regenerating…" is never a black box.
  const [job, setJob] = useState<{ id: string; status: string; log: string } | null>(null)
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const load = useCallback(() => {
    setLoading(true)
    api.listFeatureDocs(feature)
      .then((data) => { setListing(data); setError(null) })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false))
  }, [feature])

  useEffect(() => { load() }, [load])
  useEffect(() => () => { if (pollRef.current) clearTimeout(pollRef.current) }, [])

  const pollJob = useCallback((jobId: string) => {
    const tick = () => {
      api.getCoverageJob(jobId)
        .then((m) => {
          setJob({ id: m.jobId, status: m.status, log: m.log })
          if (m.status === 'running') {
            pollRef.current = setTimeout(tick, 800)
          } else {
            if (m.status === 'failed') setError(m.error ?? 'generation failed')
            setJob(null)
            load()
            onRegenerated()
            onDocsChanged?.()
          }
        })
        .catch((e: unknown) => { setError(e instanceof Error ? e.message : String(e)); setJob(null) })
    }
    tick()
  }, [load, onRegenerated, onDocsChanged])

  // Generate / regenerate the PRD summary as an async job with a live log.
  const regenerate = useCallback(() => {
    setError(null)
    api.startCoverageJob(feature, 'summary')
      .then((m) => { setJob({ id: m.jobId, status: m.status, log: m.log }); pollJob(m.jobId) })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }, [feature, pollJob])

  const clearSummary = useCallback(() => {
    setBusy(true)
    api.clearPrdSummary(feature)
      .then(() => { load(); onRegenerated(); onDocsChanged?.() })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false))
  }, [feature, load, onRegenerated, onDocsChanged])

  const importFile = useCallback(async (file: File) => {
    setBusy(true)
    setError(null)
    try {
      const base64 = await readAsBase64(file)
      await api.importFeatureDoc(feature, { filename: file.name, contentType: file.type || undefined, base64 })
      load()
      onDocsChanged?.()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [feature, load, onDocsChanged])

  const removeDoc = useCallback((relPath: string) => {
    setBusy(true)
    api.deleteFeatureDoc(feature, relPath)
      .then(() => { load(); onDocsChanged?.() })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false))
  }, [feature, load, onDocsChanged])

  const onDrop = useCallback((e: DragEvent) => {
    e.preventDefault()
    setDragging(false)
    const file = e.dataTransfer.files?.[0]
    if (file) void importFile(file)
  }, [importFile])

  const sourceCount = listing?.sourceDocCount ?? 0
  const dirPrefix = `features/${feature}/docs/`

  return (
    <div
      className="min-h-0 flex-1 overflow-auto"
      data-testid="coverage-docs-tab"
      onDragOver={(e) => { e.preventDefault(); if (!dragging) setDragging(true) }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setDragging(false) }}
      onDrop={onDrop}
      style={{ position: 'relative' }}
    >
      <input
        ref={fileInputRef}
        data-testid="doc-file-input"
        type="file"
        accept=".md,.markdown,.txt,.pdf,.docx"
        style={{ display: 'none' }}
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file) void importFile(file)
          e.target.value = ''
        }}
      />

      <div style={{ maxWidth: 680, margin: '0 auto', padding: '28px 24px 40px' }}>
        {/* Header */}
        <div className="flex items-center gap-3" style={{ marginBottom: 6 }}>
          <h2 style={{ fontSize: 18, fontWeight: 700, color: 'var(--text-primary)' }}>Source docs</h2>
          {listing && (listing.docsDrift || !listing.hasPrdSummary) && (
            <span
              data-testid="docs-tab-drift"
              style={{ fontSize: 11, color: 'rgb(251, 191, 36)', border: '1px solid rgb(251,191,36)', borderRadius: 999, padding: '2px 9px' }}
            >
              {listing.hasPrdSummary ? 'Docs changed since last summary' : 'No PRD summary yet'}
            </span>
          )}
          {(() => {
            const noSummary = !listing?.hasPrdSummary
            const generating = Boolean(job)
            const canGen = !busy && !generating && sourceCount > 0
            return (
              <button
                type="button"
                data-testid="regenerate-prd"
                onClick={regenerate}
                disabled={!canGen}
                className="cl-button ml-auto px-3 py-1.5"
                title={sourceCount === 0
                  ? 'Add a source doc first'
                  : noSummary
                    ? 'Generate the PRD summary from these docs'
                    : 'Regenerate the PRD summary (preserves requirement ids)'}
                style={canGen ? { background: 'var(--accent)', color: '#0b0f17', borderColor: 'var(--accent)', fontWeight: 600 } : undefined}
              >
                {generating ? 'Generating…' : noSummary ? 'Generate PRD summary' : 'Regenerate PRD summary'}
              </button>
            )
          })()}
        </div>
        <p style={{ fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.5, marginBottom: 22 }}>
          The PRD requirements are extracted from these. Upload a spec, ticket, or notes file — or drop one anywhere on this panel.
        </p>

        {job && (
          <div data-testid="summary-job-stream" style={{ marginBottom: 18 }}>
            <div style={{ fontSize: 11, color: 'rgb(56, 189, 248)', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
              <span className="cl-status-dot bg-sky-500 animate-pulse" style={{ width: 7, height: 7, borderRadius: '50%', background: 'rgb(56,189,248)' }} />
              Generating PRD summary…
            </div>
            <pre
              style={{
                margin: 0, maxHeight: 200, overflow: 'auto', fontSize: 11, lineHeight: 1.5,
                fontFamily: 'var(--font-mono, monospace)', color: 'var(--text-secondary)', whiteSpace: 'pre-wrap',
                background: 'var(--bg-base)', border: '1px solid var(--border-default)', borderRadius: 'var(--radius-md)', padding: 12,
              }}
            >
              {job.log || 'Starting the summarizer…'}
            </pre>
          </div>
        )}

        {loading && <div style={{ color: 'var(--text-secondary)', fontSize: 13 }}>Loading docs…</div>}
        {error && <div data-testid="docs-error" style={{ color: 'rgb(251, 113, 133)', fontSize: 13, marginBottom: 14 }}>{error}</div>}

        {!loading && listing && (
          listing.docs.length === 0 ? (
            <EmptyDropzone onPick={() => fileInputRef.current?.click()} dragging={dragging} busy={busy} />
          ) : (
            <div className="flex flex-col" style={{ gap: 10 }}>
              {listing.docs.map((d) => (
                <DocCard
                  key={d.relPath}
                  relPath={d.relPath}
                  dirPrefix={dirPrefix}
                  generated={d.generated}
                  sizeBytes={d.sizeBytes}
                  busy={busy}
                  onRemove={() => (d.generated ? clearSummary() : removeDoc(d.relPath))}
                  removeTitle={d.generated ? 'Remove the generated PRD summary' : 'Remove source doc'}
                />
              ))}
              <button
                type="button"
                data-testid="add-another-doc"
                onClick={() => fileInputRef.current?.click()}
                disabled={busy}
                className="flex w-full items-center justify-center gap-2"
                style={{
                  padding: '12px 18px', borderRadius: 'var(--radius-md)',
                  border: '1px dashed var(--border-default)', background: 'transparent',
                  color: 'var(--text-muted)', cursor: 'pointer', fontSize: 12.5,
                }}
              >
                <span aria-hidden="true" style={{ fontSize: 14, lineHeight: 1 }}>+</span>
                Add another doc — drop a file or click to browse
              </button>
            </div>
          )
        )}

        {!loading && listing?.prdSummaryGeneratedAt && (
          <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 18 }}>
            PRD summary generated {new Date(listing.prdSummaryGeneratedAt).toLocaleString()}. Regeneration preserves
            existing requirement ids so <code>@req-*</code> tags keep resolving.
          </div>
        )}
      </div>

      {/* Full-panel drag overlay — makes the whole tab a drop target. */}
      {dragging && (
        <div
          data-testid="drop-overlay"
          className="pointer-events-none absolute inset-0 flex items-center justify-center"
          style={{ background: 'color-mix(in srgb, var(--accent) 10%, transparent)', border: '2px dashed var(--accent)', borderRadius: 'var(--radius-md)' }}
        >
          <span style={{ fontSize: 15, fontWeight: 600, color: 'var(--accent)' }}>Drop to add a source doc</span>
        </div>
      )}
    </div>
  )
}

function DocCard({ relPath, dirPrefix, generated, sizeBytes, busy, onRemove, removeTitle }: {
  relPath: string
  dirPrefix: string
  generated: boolean
  sizeBytes: number
  busy: boolean
  onRemove: () => void
  removeTitle: string
}) {
  return (
    <div
      data-testid={`doc-pill-${relPath}`}
      className="flex items-center gap-3.5"
      style={{
        padding: '15px 18px',
        borderRadius: 'var(--radius-md)',
        background: 'var(--bg-surface)',
        border: '1px solid var(--border-default)',
      }}
    >
      <span
        aria-hidden="true"
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded"
        style={{
          background: 'color-mix(in srgb, var(--text-muted) 12%, transparent)',
          color: generated ? 'rgb(56,189,248)' : 'var(--text-secondary)',
        }}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <path d="M14 2v6h6" />
        </svg>
      </span>
      <div className="min-w-0 flex-1">
        <div style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 14, lineHeight: 1.3 }} className="truncate">
          <span style={{ color: 'var(--text-muted)' }}>{dirPrefix}</span>
          <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{relPath}</span>
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 3 }}>
          {generated ? 'Generated PRD artifact' : 'Source doc'} · {formatBytes(sizeBytes)}
        </div>
      </div>
      <button
        type="button"
        data-testid={`remove-doc-${relPath}`}
        onClick={onRemove}
        disabled={busy}
        aria-label={`Remove ${relPath}`}
        title={removeTitle}
        className="cl-icon-button h-7 w-7 shrink-0"
        style={{ color: 'var(--text-muted)' }}
      >
        ✕
      </button>
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
        padding: '52px 24px',
        borderRadius: 'var(--radius-md)',
        border: `2px dashed ${dragging ? 'var(--accent)' : 'var(--border-default)'}`,
        background: dragging ? 'color-mix(in srgb, var(--accent) 8%, transparent)' : 'var(--bg-surface)',
        cursor: 'pointer',
        transition: 'border-color 150ms, background 150ms',
      }}
    >
      <span
        aria-hidden="true"
        className="flex h-12 w-12 items-center justify-center rounded-full"
        style={{ background: 'color-mix(in srgb, var(--accent) 12%, transparent)', color: 'var(--accent)' }}
      >
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 5v14M5 12h14" />
        </svg>
      </span>
      <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>Add a source doc</span>
      <span style={{ fontSize: 12.5, color: 'var(--text-secondary)', maxWidth: 360 }}>
        Drop a spec, ticket, or notes file here — or click to browse. Accepts <code>.md</code>, <code>.txt</code>, <code>.pdf</code>, <code>.docx</code>.
      </span>
    </button>
  )
}
