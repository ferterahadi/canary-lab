import { useState } from 'react'
import type { ReactNode } from 'react'
import * as api from '@/shared/api/client'
import type { ConfigValue, ParsedConfigDoc } from '@/shared/api/client'
import { PlusIcon, Section } from '@/shared/ui/atoms'
import { SaveBar } from './SaveBar'
import { useEditableSlice } from './useEditableSlice'
import { useRuns } from '@/features/runs'
import { isActiveRunStatus } from '@shared/run-state'
import { useInvalidationKey } from '@/shared/state/invalidation'
import { RepoCard } from './RepoCard'
import { PortSlotSlice, RepoSlice, Slice, parseRepo, sameProbePath, serializeRepo } from './repo-slice'

export { deriveRepoName, parseRepo, serializeRepo } from './repo-slice'
export type { CommandSlice, PortSlotSlice, ProbePath, RepoSlice } from './repo-slice'

export function ReposTab({ feature }: { feature: string }) {
  // Each repo's git-status row refetches on `features-changed` (an MCP/other-tab
  // branch checkout) so it shows live.
  const refreshKey = useInvalidationKey('repos')
  const { runs } = useRuns()
  const activeRun = runs.some((run) =>
    run.feature === feature && isActiveRunStatus(run.status))
  const ed = useEditableSlice<ParsedConfigDoc, Slice>({
    // Shared with General + Ports — one config doc, one fetch per dialog open.
    cacheKey: `config-doc:${feature}`,
    load: () => api.getFeatureConfigDoc(feature),
    extract: (doc) => {
      const v = (doc.parsed.value ?? {}) as { [k: string]: ConfigValue }
      const repos = Array.isArray(v.repos)
        ? v.repos.map(parseRepo).filter((r): r is RepoSlice => r != null)
        : []
      const rootEnvs = Array.isArray(v.envs)
        ? v.envs.filter((x): x is string => typeof x === 'string')
        : []
      return { repos, rootEnvs }
    },
    merge: (doc, slice) => {
      const current = (doc.parsed.value ?? {}) as { [k: string]: ConfigValue }
      const repos = slice.repos.map(serializeRepo)
      return { ...current, repos }
    },
    save: (payload) => api.putFeatureConfigDoc(feature, payload as ConfigValue),
  })

  if (ed.error && !ed.draft) {
    return <div className="p-4 text-xs" style={{ color: 'var(--danger)' }}>{ed.error}</div>
  }
  if (ed.loading || !ed.draft) {
    return <div className="p-4 text-xs" style={{ color: 'var(--text-muted)' }}>Loading…</div>
  }

  const { repos, rootEnvs } = ed.draft

  const addRepo = (): void => {
    ed.setDraft((d) => ({
      ...d,
      repos: [
        ...d.repos,
        {
          name: '',
          localPath: '',
          startCommands: [{ name: '', command: '', health: { mode: 'none' } }],
        },
      ],
    }))
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin">
        <div className="p-3">
        <Section title="Services" bodyClassName="px-3.5 py-3 flex flex-col gap-3">
          {repos.length === 0 && (
            <div className="text-xs" style={{ color: 'var(--text-muted)' }}>No services configured.</div>
          )}
          {repos.map((repo, i) => {
            const persistedRepo = ed.baseline?.repos.find((r) => sameProbePath(r.localPath, repo.localPath))
            return (
              <RepoCard
                key={i}
                feature={feature}
                repo={repo}
                repoLookupName={persistedRepo?.name}
                rootEnvs={rootEnvs}
                activeRun={activeRun}
                refreshKey={refreshKey}
                onChange={(next) => ed.setDraft((d) => ({
                  ...d,
                  repos: d.repos.map((r, j) => j === i ? next : r),
                }))}
                onRemove={() => ed.setDraft((d) => ({
                  ...d,
                  repos: d.repos.filter((_, j) => j !== i),
                }))}
              />
            )
          })}
          <button
            type="button"
            onClick={addRepo}
            className="self-start inline-flex items-center gap-1 rounded-md px-2.5 py-1.5 text-[11px] uppercase tracking-wider transition-colors duration-150"
            style={{ color: 'var(--text-muted)', border: '1px dashed var(--border-default)' }}
            onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--text-primary)' }}
            onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-muted)' }}
          >
            <PlusIcon />
            Add Service
          </button>
        </Section>
        </div>
      </div>

      <SaveBar
        dirty={ed.dirty}
        saving={ed.saving}
        error={ed.error}
        savedAt={ed.savedAt}
        onSave={ed.doSave}
        onDiscard={ed.discard}
      />
    </div>
  )
}

// ─── port-slot table (display-only) ─────────────────────────────────────────

/**
 * Read-only view of a start-command's injectable port slots. Slots are authored
 * in the feature config file (well-behaved services that read a port from env)
 * or written by Portify (hardcoded-port services it rewrites) — never hand-edited
 * in the UI, which only confused (the env/reference relationship is expert-dense
 * and nobody types it here). The Ports tab renders this; editing happens in the
 * config or via Portify.
 */
export function PortSlotTable({
  ports,
  emptyHint,
}: {
  ports: PortSlotSlice[]
  /** Overrides the default "(none — …)" line shown when there are no slots.
   *  The Ports tab passes a Portify-aware nudge here for not-yet-portified
   *  features. */
  emptyHint?: ReactNode
}) {
  return (
    <div className="flex flex-col gap-1.5">
      {ports.length === 0 && (
        emptyHint ?? (
          <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
            (none — service uses its hardcoded port; can't run concurrently)
          </div>
        )
      )}
      {ports.length > 0 && (
        <div className="flex items-center gap-1.5 px-0.5 text-[9px] uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
          <span className="flex-1">Reference</span>
          <span className="flex-1">Env var</span>
        </div>
      )}
      {/* Two columns, not three: the bare slot name ("mpass") was the same
          identifier the `${port.mpass}` reference already carries. The token
          cell (click-to-copy) is the one you paste elsewhere; env var is what
          the service reads — the two genuinely distinct values. */}
      {ports.map((slot, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <PortSlotToken name={slot.name} env={slot.env} />
          <span className="flex-1 truncate px-0.5 py-1 text-[11px]" style={{ color: slot.env ? 'var(--text-primary)' : 'var(--text-muted)', fontFamily: 'var(--font-mono)' }} title={slot.env ?? ''}>
            {slot.env || '—'}
          </span>
        </div>
      ))}
    </div>
  )
}

// Display of what a slot injects at run time: the `${port.<name>}` token to
// reference elsewhere (health-check URLs, envset files, inter-service config)
// and the env var the service reads. The actual port number is allocated per
// run and only exists while a run is active — settings shows the reference,
// not a concrete number. Click copies the token for pasting where it's needed.
function PortSlotToken({ name, env }: { name: string; env?: string }) {
  const [copied, setCopied] = useState(false)
  const ready = name.trim().length > 0
  const token = ready ? `\${port.${name.trim()}}` : '${port.…}'
  const label = env ? `Injected as ${env}; reference with ${token}` : `Reference with ${token}`
  const copy = (): void => {
    if (!ready) return
    void navigator.clipboard
      ?.writeText(token)
      .then(() => {
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1200)
      })
      .catch(() => {})
  }
  // Box-less: in an otherwise plain-text row a bordered box reads as an
  // editable field — a false affordance now that nothing here is editable. The
  // token is the only interactive thing; cursor + hover underline carry that.
  return (
    <button
      type="button"
      onClick={copy}
      disabled={!ready}
      className="flex-1 truncate px-0.5 py-1 text-left text-[11px] transition-colors hover:underline"
      title={ready ? `${label} — click to copy` : label}
      aria-label={ready ? `${label} — click to copy` : label}
      style={{
        background: 'transparent',
        border: 'none',
        color: ready ? 'var(--text-secondary)' : 'var(--text-muted)',
        fontFamily: 'var(--font-mono)',
        cursor: ready ? 'copy' : 'default',
      }}
    >
      {copied ? 'copied ✓' : token}
    </button>
  )
}
