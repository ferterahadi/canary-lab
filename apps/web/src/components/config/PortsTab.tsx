import * as api from '../../api/client'
import type { ConfigValue, ParsedConfigDoc } from '../../api/client'
import { SaveBar } from './SaveBar'
import { useEditableSlice } from './useEditableSlice'
import {
  deriveRepoName,
  parseRepo,
  serializeRepo,
  PortSlotEditor,
  type PortSlotSlice,
  type RepoSlice,
} from './ReposTab'

interface PortsSlice {
  repos: RepoSlice[]
}

/**
 * Dedicated home for a feature's injectable port slots — the one place to
 * declare them (the Service tab no longer edits ports inline) and to launch
 * Portify. Slots are nested per start-command per service, so this tab groups
 * by service → command and writes back into the same `repos[]` structure the
 * Service tab edits.
 */
export function PortsTab({
  feature,
  onStartPortify,
}: {
  feature: string
  onStartPortify?: (feature: string) => void
}) {
  const ed = useEditableSlice<ParsedConfigDoc, PortsSlice>({
    load: () => api.getFeatureConfigDoc(feature),
    extract: (doc) => {
      const v = (doc.parsed.value ?? {}) as { [k: string]: ConfigValue }
      const repos = Array.isArray(v.repos)
        ? v.repos.map(parseRepo).filter((r): r is RepoSlice => r != null)
        : []
      return { repos }
    },
    merge: (doc, slice) => {
      const current = (doc.parsed.value ?? {}) as { [k: string]: ConfigValue }
      return { ...current, repos: slice.repos.map(serializeRepo) }
    },
    save: (payload) => api.putFeatureConfigDoc(feature, payload as ConfigValue),
    deps: [feature],
  })

  if (ed.error && !ed.draft) {
    return <div className="p-4 text-xs" style={{ color: 'var(--danger)' }}>{ed.error}</div>
  }
  if (ed.loading || !ed.draft) {
    return <div className="p-4 text-xs" style={{ color: 'var(--text-muted)' }}>Loading…</div>
  }

  const { repos } = ed.draft

  const setPorts = (ri: number, ci: number, ports: PortSlotSlice[]): void => {
    ed.setDraft((d) => ({
      repos: d.repos.map((r, i) =>
        i !== ri
          ? r
          : {
              ...r,
              startCommands: r.startCommands.map((c, j) =>
                j !== ci ? c : { ...c, ports: ports.length > 0 ? ports : undefined },
              ),
            },
      ),
    }))
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin">
        {/* Intro band: what ports are for + the primary Portify action. The
            active tab already reads "Ports", so there's no redundant section
            title here — Portify is positioned as this tab's headline action,
            top-right of its own explanation. */}
        <div
          className="flex items-start justify-between gap-4 px-4 py-3"
          style={{ borderBottom: '1px solid var(--border-default)' }}
        >
          <p className="text-[11px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
            Declare the ports each service needs. Every slot gets a free port per run,
            injected as the env var the service reads (e.g.{' '}
            <code style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)' }}>PORT</code>),
            and referenced elsewhere as{' '}
            <code style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)' }}>{'${port.<name>}'}</code>{' '}
            — in the start command, the health-check URL, or applied envset files. This lets
            benchmark arms and concurrent runs boot the same app without clashing.
          </p>
          {onStartPortify && (
            <button
              type="button"
              onClick={() => onStartPortify(feature)}
              className="shrink-0 inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[11px] font-medium transition-colors duration-150"
              title="Portify — not sure where a service binds? Detect and rewrite every listener to an injectable port automatically, so it can boot concurrently (benchmark arms / parallel runs)."
              style={{
                color: 'var(--accent)',
                border: '1px solid color-mix(in srgb, var(--accent) 45%, var(--border-default))',
                background: 'color-mix(in srgb, var(--accent) 8%, transparent)',
              }}
            >
              <span aria-hidden>🔌</span>
              Portify
            </button>
          )}
        </div>

        <div className="flex flex-col gap-3 px-4 py-3">
          {repos.length === 0 && (
            <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
              No services configured. Add services in the Service tab first.
            </div>
          )}

          {repos.map((repo, ri) => (
            <div
              key={ri}
              className="rounded-md"
              style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-default)' }}
            >
              <header
                className="flex items-center gap-2 px-3 py-2"
                style={{ borderBottom: '1px solid var(--border-default)' }}
              >
                <span className="truncate text-sm font-medium" style={{ color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' }}>
                  {repo.name || deriveRepoName(repo.localPath, repo.cloneUrl) || '(unnamed service)'}
                </span>
              </header>

              <div className="flex flex-col gap-3 px-3 py-2.5">
                {repo.startCommands.length === 0 && (
                  <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                    No start commands. Add one in the Service tab.
                  </div>
                )}
                {repo.startCommands.map((cmd, ci) => (
                  <div key={ci} className="flex flex-col gap-1.5">
                    <div
                      className="truncate text-[11px]"
                      style={{ color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}
                      title={cmd.command}
                    >
                      <span style={{ color: 'var(--text-muted)' }}>▸ </span>
                      {cmd.command || cmd.name || '(unnamed command)'}
                    </div>
                    <PortSlotEditor
                      ports={cmd.ports ?? []}
                      onChange={(ports) => setPorts(ri, ci, ports)}
                    />
                  </div>
                ))}
              </div>
            </div>
          ))}
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
