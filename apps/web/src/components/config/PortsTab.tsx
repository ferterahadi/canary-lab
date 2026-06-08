import * as api from '../../api/client'
import type { ConfigValue, ParsedConfigDoc } from '../../api/client'
import { SectionHeader } from './atoms'
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
        <div className="flex items-center justify-between pr-3">
          <SectionHeader>Ports</SectionHeader>
          {onStartPortify && (
            <button
              type="button"
              onClick={() => onStartPortify(feature)}
              className="shrink-0 inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-[11px]"
              title="Portify — make this feature's ports injectable so it can boot concurrently (benchmark arms / parallel runs)"
              style={{ color: 'var(--accent)', border: '1px solid color-mix(in srgb, var(--accent) 45%, var(--border-default))' }}
            >
              <span aria-hidden>🔌</span>
              Portify
            </button>
          )}
        </div>

        <div className="flex flex-col gap-3 px-4 py-3">
          <p className="text-[11px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
            Declare the ports each service needs. Every slot gets a free port per run,
            injected as the env var the service reads (e.g.{' '}
            <code style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)' }}>PORT</code>),
            and referenced elsewhere as{' '}
            <code style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)' }}>{'${port.<name>}'}</code>{' '}
            — in the start command, the health-check URL, or applied envset files. This lets
            benchmark arms and concurrent runs boot the same app without clashing. Not sure
            where a service binds? Run <strong style={{ color: 'var(--accent)' }}>Portify</strong> to
            detect and rewrite every listener automatically.
          </p>

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
