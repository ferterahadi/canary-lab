import { useState } from 'react'
import * as api from '@/shared/api/client'
import type { PortifyManifest } from '@/shared/api/client'
import { DiffView } from '@/shared/ui/DiffView'
import { patchFileName } from '@shared/portify-overlay'

// The one rendering of a feature's SAVED port overlay — the captured diff, the
// open-in-editor control, the double-boot proof, and the per-service
// stored-in rows. Shared by the Portify wizard's saved Review screen and the
// Ports tab's inline overlay detail, so the two surfaces can never drift on
// what a saved overlay looks like or claims.
export function SavedOverlayPanel({
  manifest: m,
  collapsibleDiff = false,
  showServiceTable = true,
}: {
  manifest: PortifyManifest
  /** Collapse the diff behind a "Show diff" toggle, closed by default. The Ports
   *  tab passes true — in the verified state the overlay is already trusted (the
   *  boot badge is the proof), so the diff is on-demand reference detail. The
   *  wizard's saved-review screen leaves it expanded. */
  collapsibleDiff?: boolean
  /** Render the per-service "Stored in" table. The wizard shows it (it has no
   *  other place for the patch paths); the Ports tab passes false and folds the
   *  stored-in path into each repo card header instead, so the service list
   *  isn't enumerated twice on that screen. */
  showServiceTable?: boolean
}) {
  const [openError, setOpenError] = useState<string | null>(null)
  const [showDiff, setShowDiff] = useState(!collapsibleDiff)
  // For a saved workflow the server opens the overlay folder
  // (features/<feature>/portify/) — the scratch worktrees are long gone.
  // Best-effort: the route never rejects on a launch failure, it reports it.
  const openOverlay = async (): Promise<void> => {
    setOpenError(null)
    try {
      const res = await api.openPortifyProject(m.workflowId)
      if (!res.opened) setOpenError(res.error ?? 'Failed to open editor')
    } catch (e) {
      setOpenError(e instanceof Error ? e.message : 'Failed to open editor')
    }
  }
  const hasDiff = (m.diff ?? '').trim().length > 0
  // Changed-line count for the collapsed toggle label — the +/- lines, minus the
  // `+++`/`---` file headers, so "N lines" reads as churn, not raw line count.
  const changedLines = hasDiff
    ? m.diff!.split('\n').filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---)/.test(l)).length
    : 0
  return (
    <div>
      <VerificationBadge m={m} />

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 8 }}>
        {collapsibleDiff && hasDiff ? (
          <button
            type="button"
            onClick={() => setShowDiff((v) => !v)}
            aria-expanded={showDiff}
            style={{
              ...sectionLabel, display: 'inline-flex', alignItems: 'center', gap: 6,
              background: 'transparent', border: 'none', padding: 0, cursor: 'pointer',
            }}
          >
            <span aria-hidden>{showDiff ? '▾' : '▸'}</span>
            {showDiff ? 'Hide diff' : `Show diff${changedLines > 0 ? ` · ${changedLines} lines` : ''}`}
          </button>
        ) : collapsibleDiff ? (
          /* No-op overlay in the compact surface: the same one-line slot the diff
             toggle occupies, minus the chevron — there is nothing to expand. The
             ✓ carries the "this is fine" (echoing the boot badge); the label stays
             muted like every other section label so it reads as a state, not an alert. */
          <span style={{ ...sectionLabel, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span aria-hidden style={{ color: 'var(--success)' }}>✓</span>
            No changes needed
          </span>
        ) : (
          <span style={sectionLabel}>Saved overlay</span>
        )}
        <button
          type="button"
          onClick={openOverlay}
          title="Open overlay in editor"
          aria-label="Open overlay in editor"
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            background: 'transparent', border: '1px solid var(--border-default)',
            borderRadius: 'var(--radius-md)', color: 'var(--text-secondary)',
            fontSize: 11, fontWeight: 500, padding: '5px 10px', cursor: 'pointer',
            transition: 'background 120ms, color 120ms',
          }}
        >
          <span aria-hidden>↗</span> Open in editor
        </button>
      </div>
      {openError && (
        <div style={{ fontSize: 10.5, color: 'var(--danger)', marginBottom: 6 }}>{openError}</div>
      )}

      {/* One combined diff: sections are headed by `# repo:` / `# feature
          config:` markers (coloured by DiffView) — never split per service,
          which is lossy when services share a git root. A saved-but-empty diff
          is a valid no-op overlay: the apps already read injected ports. */}
      {hasDiff
        ? (showDiff ? <DiffView diff={m.diff!} /> : null)
        : collapsibleDiff
          ? <NoChangesReason feature={m.feature} />
          : <NoChangesNeeded feature={m.feature} />}

      {/* Where each patch lives — only when the surface has nowhere else to show
          it (the wizard). The Ports tab folds this into its repo card headers, so
          it passes showServiceTable=false to avoid enumerating the services twice. */}
      {showServiceTable && (
        <div style={{ border: '1px solid var(--border-default)', borderRadius: 'var(--radius-md)', background: 'var(--bg-elevated)', padding: '13px 15px', marginTop: 12 }}>
          <div style={{ ...sectionLabel, marginBottom: 8 }}>Stored in</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'max-content minmax(0,1fr)', columnGap: 16, rowGap: 5, alignItems: 'baseline' }}>
            <span style={colHeader}>Service</span>
            <span style={colHeader}>Patch file</span>
            {m.repos.map((r) => (
              <PerServiceRow key={r.name} feature={m.feature} repoName={r.name} />
            ))}
          </div>
        </div>
      )}

      {/* How the overlay is applied — one line, always. Replaces the old
          per-service "Applied" column, whose value never varied per service,
          and absorbs the "repo is never modified" reassurance so it's stated
          once here rather than repeated across the band and a second caption. */}
      <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.55, marginTop: 12 }}>
        Applied per-run in an isolated worktree, reversed at teardown. Your product repo is never touched.
      </div>
    </div>
  )
}

function PerServiceRow({ feature, repoName }: { feature: string; repoName: string }) {
  return (
    <>
      <span style={{ fontSize: 12, fontFamily: 'var(--font-mono)', color: 'var(--text-primary)' }}>{repoName}</span>
      <span
        title="Inside your canary workspace — not the product repo"
        style={{ fontSize: 12, fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
      >
        {`features/${feature}/portify/${patchFileName(repoName)}`}
      </span>
    </>
  )
}

/** Machine proof the overlay works: the two concurrent boot instances and the
 *  ports each drew. Renders nothing until both instances passed. */
export function VerificationBadge({ m }: { m: PortifyManifest }) {
  const insts = m.verification?.instances ?? []
  if (insts.length < 2 || !m.verification?.ok) return null
  const fmt = (p: Record<string, number>) => Object.entries(p).map(([k, v]) => `${k}:${v}`).join(' ')
  return (
    <div style={{ fontSize: 12, fontFamily: 'var(--font-mono)', color: 'var(--success)', background: 'color-mix(in srgb, var(--success) 10%, transparent)', border: '1px solid color-mix(in srgb, var(--success) 30%, transparent)', borderRadius: 'var(--radius-md)', padding: '8px 11px', marginBottom: 14 }}>
      ✓ Booted twice — {fmt(insts[0].ports)} and {fmt(insts[1].ports)} — both healthy
    </div>
  )
}

// The compact twin of NoChangesNeeded, for surfaces where the diff collapses to a
// single line (the Ports tab): the header slot already says "✓ No changes needed",
// so all that's left is the *why*. One muted line keeps the fact a card would have
// carried, at the density of the collapsed-diff state next to it.
function NoChangesReason({ feature }: { feature: string }) {
  return (
    <div style={{ fontSize: 11.5, color: 'var(--text-muted)', lineHeight: 1.55 }}>
      <b style={{ color: 'var(--text-secondary)', fontWeight: 600 }}>{feature}</b> already reads
      injected ports — nothing to rewrite. Saved as a no-op overlay.
    </div>
  )
}

// Shown in place of the diff when the verified rewrite produced no edits — the
// apps already read injected ports, so portify is a no-op overlay. A reassuring
// success state, not a "missing data" apology. Used where the panel owns the view
// and a review moment deserves the room (the wizard); compact surfaces get
// NoChangesReason instead.
export function NoChangesNeeded({ feature }: { feature: string }) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', gap: 9,
      padding: '30px 26px', background: 'var(--bg-base)',
      border: '1px solid var(--border-default)', borderRadius: 'var(--radius-md)',
    }}>
      <span style={{
        width: 36, height: 36, borderRadius: 9999, display: 'grid', placeItems: 'center',
        background: 'color-mix(in srgb, var(--success) 12%, transparent)', border: '1px solid color-mix(in srgb, var(--success) 35%, transparent)',
        color: 'var(--success)', fontSize: 17, lineHeight: 1,
      }}>✓</span>
      <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text-primary)' }}>
        No changes needed
      </div>
      <div style={{ fontSize: 12.5, color: 'var(--text-muted)', lineHeight: 1.6, maxWidth: 380 }}>
        <b style={{ color: 'var(--text-secondary)' }}>{feature}</b> already reads injected ports — nothing to rewrite. Saved as a no-op overlay.
      </div>
    </div>
  )
}

const sectionLabel: React.CSSProperties = {
  fontSize: 10, fontFamily: 'var(--font-mono)', textTransform: 'uppercase',
  letterSpacing: '0.08em', color: 'var(--text-muted)', fontWeight: 500,
}

const colHeader: React.CSSProperties = {
  fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '.4px',
  color: 'var(--text-muted)', fontWeight: 600,
}
