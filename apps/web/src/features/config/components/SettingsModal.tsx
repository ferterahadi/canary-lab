import { useEffect, useState } from 'react'
import * as api from '../../../api/client'
import type { EditorChoice, HealAgentChoice, ProjectConfig } from '../../../api/client'
import { CloseIcon } from './atoms'
import { FolderPicker } from './FolderPicker'

// `auto` and `manual` are intentionally omitted from the settings UI. The
// server still accepts them for old config files and run-level compatibility,
// but the modern project-level choice is external client ownership.
type VisibleHealAgentChoice = Extract<HealAgentChoice, 'external' | 'claude' | 'codex'>

const HEAL_AGENT_OPTIONS: { value: VisibleHealAgentChoice; label: string; description: string }[] = [
  {
    value: 'external',
    label: 'External client',
    description: 'Let Claude / Codex Desktop or CLI drive heal over MCP. Canary Lab waits for that client to claim and signal.',
  },
  {
    value: 'claude',
    label: 'Claude',
    description: 'Always use the `claude` CLI for auto-heal.',
  },
  {
    value: 'codex',
    label: 'Codex',
    description: 'Always use the `codex` CLI for auto-heal.',
  },
]

// Map legacy `auto` / `manual` saved config to the new default (`external`) for
// display. Saving will persist the new value, retiring it in this project.
function migrateLegacyHealAgent(value: HealAgentChoice): HealAgentChoice {
  return value === 'auto' || value === 'manual' ? 'external' : value
}

const EDITOR_OPTIONS: { value: EditorChoice; label: string; description: string }[] = [
  {
    value: 'auto',
    label: 'Auto-detect',
    description: 'Prefer Cursor, then VS Code, then the system default.',
  },
  {
    value: 'cursor',
    label: 'Cursor',
    description: 'Open files with `cursor -g`.',
  },
  {
    value: 'vscode',
    label: 'VS Code',
    description: 'Open files with `code -g`.',
  },
  {
    value: 'system',
    label: 'System default',
    description: 'Open files with the operating system default app.',
  },
]

const DEFAULT_PORT = 7421

// The restart moves through three honest phases the UI can narrate: the old
// server releasing the port, the new server binding it, and the reconnect.
type RestartPhase = 'stopping' | 'waiting' | 'reconnecting'

// How many times we probe the new origin before giving up and navigating
// anyway. Shared with the progress UI so "probe N of M" stays truthful.
const RESTART_MAX_PROBES = 40
// After this many probes the new server is taking unusually long; the UI
// switches to a "still starting" hint and surfaces a manual escape hatch.
const RESTART_SLOW_AFTER = 8

// Poll the new origin until it answers, then navigate the tab to it. The old
// server shuts down ~moments after the port change, and the new one needs a
// beat to bind, so an immediate redirect could hit a dead port. `onProgress`
// lets the caller narrate which phase we're in (and how many probes deep).
function defaultRedirect(
  newOrigin: string,
  onProgress?: (phase: RestartPhase, attempt: number) => void,
): void {
  let tries = 0
  const poll = (): void => {
    tries += 1
    onProgress?.('waiting', tries)
    fetch(`${newOrigin}/api/project-config`)
      .then((r) => {
        if (r.ok) { onProgress?.('reconnecting', tries); window.location.href = newOrigin; return }
        throw new Error('not ready')
      })
      .catch(() => {
        if (tries < RESTART_MAX_PROBES) setTimeout(poll, 500)
        else { onProgress?.('reconnecting', tries); window.location.href = newOrigin }
      })
  }
  // Hold on "stopping" for a beat before the first probe: it gives the dying
  // process time to release the socket (so probe #1 isn't wasted on it) and
  // makes the stopping step visible rather than flashing past.
  onProgress?.('stopping', 0)
  setTimeout(poll, 450)
}

interface Props {
  onClose: () => void
  // Injected in tests; production polls the new origin then navigates the tab.
  onRedirect?: (url: string, onProgress?: (phase: RestartPhase, attempt: number) => void) => void
}

export function SettingsModal({ onClose, onRedirect }: Props) {
  const [config, setConfig] = useState<ProjectConfig | null>(null)
  const [draft, setDraft] = useState<ProjectConfig | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [portInput, setPortInput] = useState('')
  const [portBusy, setPortBusy] = useState(false)
  const [portError, setPortError] = useState<string | null>(null)
  const [pendingConfirm, setPendingConfirm] = useState<number | null>(null)
  const [restartPhase, setRestartPhase] = useState<RestartPhase | null>(null)
  const [restartAttempt, setRestartAttempt] = useState(0)
  const [restartOrigin, setRestartOrigin] = useState('')
  const restarting = restartPhase != null

  useEffect(() => {
    let cancelled = false
    api.getProjectConfig()
      .then((c) => {
        if (cancelled) return
        // Stash the as-loaded config for dirty comparison, but project the
        // legacy `auto` value to `external` in the draft so the radio group
        // shows a valid selection. Saving will persist the migrated value.
        setConfig(c)
        setDraft({ ...c, healAgent: migrateLegacyHealAgent(c.healAgent) })
        setPortInput(String(c.port ?? DEFAULT_PORT))
      })
      .catch((e: unknown) => {
        if (cancelled) return
        setError(e instanceof Error ? e.message : 'Failed to load settings')
      })
    return () => { cancelled = true }
  }, [])

  const dirty = draft != null && config != null
    && (
      draft.healAgent !== config.healAgent
      || draft.editor !== config.editor
      || (draft.personalWikiPath ?? '') !== (config.personalWikiPath ?? '')
    )

  const onSave = async (): Promise<void> => {
    if (!draft) return
    setSaving(true)
    setError(null)
    try {
      const next = await api.putProjectConfig(draft)
      setConfig(next)
      setDraft(next)
      onClose()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  const redirect = onRedirect ?? defaultRedirect
  const submitPort = async (confirm: boolean): Promise<void> => {
    const port = Number(portInput)
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      setPortError('Port must be an integer between 1 and 65535')
      return
    }
    setPortBusy(true)
    setPortError(null)
    try {
      const res = await api.changeProjectPort(port, confirm)
      if (res.needsConfirm) {
        setPendingConfirm(res.activeRuns ?? 0)
        return
      }
      setPendingConfirm(null)
      if (res.restarting && res.newOrigin) {
        setRestartOrigin(res.newOrigin)
        setRestartAttempt(0)
        setRestartPhase('stopping')
        redirect(res.newOrigin, (phase, attempt) => {
          setRestartPhase(phase)
          setRestartAttempt(attempt)
        })
      }
    } catch (e: unknown) {
      setPortError(e instanceof Error ? e.message : 'Port change failed')
    } finally {
      setPortBusy(false)
    }
  }

  return (
    <div
      className="cl-modal-backdrop fixed inset-0 z-40 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="cl-modal relative flex max-h-[calc(100vh-2rem)] w-[min(480px,100%)] flex-col overflow-hidden rounded-lg"
        style={{ background: 'var(--bg-elevated)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="cl-dialog-header">
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Project Settings</h2>
          </div>
          <button
            type="button"
            aria-label="Close settings"
            onClick={onClose}
            className="cl-icon-button h-7 w-7 shrink-0"
          >
            <CloseIcon size={14} />
          </button>
        </header>
        <div className="min-h-0 overflow-y-auto px-4 py-3">
          {!draft ? (
            <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
              {error ?? 'Loading…'}
            </div>
          ) : (
            <>
              <div className="text-[10px] uppercase tracking-wider mb-2" style={{ color: 'var(--text-muted)' }}>
                Port
              </div>
              <div className="flex items-center gap-2">
                <input
                  name="port"
                  type="number"
                  min={1}
                  max={65535}
                  value={portInput}
                  onChange={(e) => setPortInput(e.target.value)}
                  disabled={portBusy || restarting}
                  className="cl-input w-28 px-2 py-1 text-sm"
                  style={{ background: 'var(--bg-default)', color: 'var(--text-primary)', border: '1px solid var(--border-default)', borderRadius: 4 }}
                />
                <button
                  type="button"
                  onClick={() => { void submitPort(false) }}
                  disabled={portBusy || restarting}
                  className="cl-button px-3 py-1 text-xs"
                >
                  Change port
                </button>
              </div>
              <div className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
                The UI and MCP server bind this port (default {DEFAULT_PORT}). Changing it restarts Canary Lab; your MCP client may need to reconnect (restart it or toggle the connector) if it doesn&apos;t reconnect on its own.
              </div>
              {pendingConfirm != null && (
                <div className="mt-2 text-xs" style={{ color: 'var(--danger)' }}>
                  {pendingConfirm} active run{pendingConfirm === 1 ? '' : 's'} will be aborted by the restart.{' '}
                  <button
                    type="button"
                    onClick={() => { void submitPort(true) }}
                    disabled={portBusy || restarting}
                    className="cl-button px-2 py-0.5 text-xs"
                  >
                    Restart anyway
                  </button>
                </div>
              )}
              {restartPhase != null && (
                <RestartProgress
                  phase={restartPhase}
                  attempt={restartAttempt}
                  fromPort={config?.port ?? DEFAULT_PORT}
                  origin={restartOrigin}
                />
              )}
              {portError && (
                <div className="mt-1 text-xs" style={{ color: 'var(--danger)' }}>{portError}</div>
              )}
              <div className="mt-4 text-[10px] uppercase tracking-wider mb-2" style={{ color: 'var(--text-muted)' }}>
                Personal wiki
              </div>
              <FolderPicker
                value={draft.personalWikiPath}
                onChange={(p) => setDraft({ ...draft, personalWikiPath: p.trim() ? p : null })}
                placeholder="~/Documents/wiki"
                title="Select personal wiki folder"
                confirmLabel="Use wiki folder"
              />
              <div className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
                Optional Karpathy-style personal wiki folder for distilled agent notes. Auto-heal receives the path and reads only relevant notes.
              </div>
              <div className="mt-4 text-[10px] uppercase tracking-wider mb-2" style={{ color: 'var(--text-muted)' }}>
                Heal agent
              </div>
              <div className="flex flex-col gap-1.5">
                {HEAL_AGENT_OPTIONS.map((opt) => (
                  <label
                    key={opt.value}
                    className="cl-card-hover flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5"
                    style={{
                      background: draft.healAgent === opt.value ? 'var(--bg-selected)' : 'transparent',
                    }}
                  >
                    <input
                      type="radio"
                      name="healAgent"
                      value={opt.value}
                      checked={draft.healAgent === opt.value}
                      onChange={() => setDraft({ ...draft, healAgent: opt.value })}
                      className="mt-1"
                    />
                    <div className="flex-1">
                      <div className="text-sm" style={{ color: 'var(--text-primary)' }}>{opt.label}</div>
                      <div className="text-xs" style={{ color: 'var(--text-muted)' }}>{opt.description}</div>
                    </div>
                  </label>
                ))}
              </div>
              <div className="mt-4 text-[10px] uppercase tracking-wider mb-2" style={{ color: 'var(--text-muted)' }}>
                Editor
              </div>
              <div className="flex flex-col gap-1.5">
                {EDITOR_OPTIONS.map((opt) => (
                  <label
                    key={opt.value}
                    className="cl-card-hover flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5"
                    style={{
                      background: draft.editor === opt.value ? 'var(--bg-selected)' : 'transparent',
                    }}
                  >
                    <input
                      type="radio"
                      name="editor"
                      value={opt.value}
                      checked={draft.editor === opt.value}
                      onChange={() => setDraft({ ...draft, editor: opt.value })}
                      className="mt-1"
                    />
                    <div className="flex-1">
                      <div className="text-sm" style={{ color: 'var(--text-primary)' }}>{opt.label}</div>
                      <div className="text-xs" style={{ color: 'var(--text-muted)' }}>{opt.description}</div>
                    </div>
                  </label>
                ))}
              </div>
            </>
          )}
        </div>
        <div className="cl-panel-footer flex items-center justify-end gap-2 px-4 py-3">
          {error && <span className="mr-auto text-xs" style={{ color: 'var(--danger)' }}>{error}</span>}
          <button
            type="button"
            onClick={onClose}
            className="cl-button px-3 py-1 text-xs"
          >
            Close
          </button>
          <button
            type="button"
            onClick={onSave}
            disabled={!dirty || saving}
            className="cl-button px-3 py-1 text-xs"
            style={{
              color: dirty ? 'var(--border-focus)' : 'var(--text-muted)',
              border: '1px solid',
              borderColor: dirty ? 'color-mix(in srgb, var(--border-focus) 40%, transparent)' : 'var(--border-default)',
              background: dirty ? 'color-mix(in srgb, var(--border-focus) 8%, transparent)' : 'transparent',
              opacity: saving ? 0.6 : 1,
            }}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}

function parsePort(origin: string): number | null {
  try {
    const p = Number(new URL(origin).port)
    return Number.isFinite(p) && p > 0 ? p : null
  } catch {
    return null
  }
}

// Narrate the restart as it happens instead of a single static line. The header
// shows the actual port hop (old → new), each step fills in as we pass it, and
// the active step carries a live, bounded readout ("probe 6 of 40") so the user
// can tell forward progress from a hang. If the new server is slow to bind we
// switch to a reassuring hint and surface a manual link to the new origin.
function RestartProgress({
  phase,
  attempt,
  fromPort,
  origin,
}: {
  phase: RestartPhase
  attempt: number
  fromPort: number
  origin: string
}) {
  const toPort = parsePort(origin)
  const slow = phase === 'waiting' && attempt >= RESTART_SLOW_AFTER
  const steps: { key: RestartPhase; label: string; detail: string }[] = [
    {
      key: 'stopping',
      label: 'Stopping the current server',
      detail: `Releasing port ${fromPort} from the old process`,
    },
    {
      key: 'waiting',
      label: toPort != null ? `Binding port ${toPort}` : 'Binding the new port',
      detail: slow
        ? `Probe ${attempt} of ${RESTART_MAX_PROBES} — still booting`
        : `Probe ${attempt} of ${RESTART_MAX_PROBES} — waiting for the server to answer`,
    },
    {
      key: 'reconnecting',
      label: 'Reconnecting',
      detail: `Reopening ${origin}`,
    },
  ]
  const currentIdx = steps.findIndex((s) => s.key === phase)

  return (
    <div
      role="status"
      aria-live="polite"
      className="mt-3 overflow-hidden rounded-lg"
      style={{
        border: '1px solid color-mix(in srgb, var(--border-focus) 32%, var(--border-default))',
        background: 'color-mix(in srgb, var(--border-focus) 6%, var(--bg-default))',
        animation: 'fm-fade-up 220ms ease',
      }}
    >
      {/* Header: live dot + title on the left, the port hop on the right. */}
      <div className="flex items-center justify-between gap-3 px-3 pt-3 pb-2.5">
        <div className="flex items-center gap-2">
          <span
            aria-hidden="true"
            className="canary-pulse inline-block rounded-full"
            style={{ width: 7, height: 7, background: 'var(--border-focus)' }}
          />
          <span className="text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>
            Restarting Canary Lab
          </span>
        </div>
        <div
          className="flex items-center gap-1.5 rounded-full px-2 py-0.5"
          style={{ background: 'color-mix(in srgb, var(--border-focus) 10%, transparent)', fontFamily: 'var(--font-mono)', fontSize: 10.5 }}
        >
          <span style={{ color: 'var(--text-muted)', textDecoration: 'line-through', textDecorationColor: 'color-mix(in srgb, var(--text-muted) 60%, transparent)' }}>:{fromPort}</span>
          <span aria-hidden="true" style={{ color: 'var(--text-muted)' }}>→</span>
          <span style={{ color: 'var(--border-focus)', fontWeight: 600 }}>:{toPort ?? '—'}</span>
        </div>
      </div>

      {/* Stepper with a rail that fills as steps complete. */}
      <ol className="flex flex-col px-3">
        {steps.map((s, i) => {
          const state = i < currentIdx ? 'done' : i === currentIdx ? 'active' : 'pending'
          const isLast = i === steps.length - 1
          const labelColor =
            state === 'active' ? 'var(--text-primary)'
            : state === 'done' ? 'var(--text-secondary)'
            : 'var(--text-muted)'
          return (
            <li key={s.key} className="flex gap-2.5">
              <div className="flex flex-col items-center" style={{ width: 14, flex: 'none' }}>
                <span className="flex items-center justify-center" style={{ marginTop: 1 }}>
                  <RestartStepGlyph state={state} />
                </span>
                {!isLast && (
                  <span
                    aria-hidden="true"
                    style={{
                      width: 1.5,
                      flex: 1,
                      minHeight: 12,
                      marginTop: 3,
                      marginBottom: 1,
                      borderRadius: 1,
                      background: i < currentIdx ? 'var(--border-focus)' : 'var(--border-default)',
                    }}
                  />
                )}
              </div>
              <div className="min-w-0" style={{ paddingBottom: isLast ? 0 : 12 }}>
                <div
                  className="text-xs leading-tight"
                  style={{ color: labelColor, fontWeight: state === 'active' ? 600 : 500 }}
                >
                  {s.label}
                </div>
                {state === 'active' && (
                  <div
                    className="mt-1 break-all leading-tight"
                    style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', fontSize: 10.5 }}
                  >
                    {s.detail}
                  </div>
                )}
              </div>
            </li>
          )
        })}
      </ol>

      {/* Footer: indeterminate activity bar + what to expect / escape hatch. */}
      <div className="px-3 pt-1 pb-3">
        {phase !== 'reconnecting' && (
          <div
            className="h-[3px] w-full overflow-hidden rounded-full"
            style={{ background: 'color-mix(in srgb, var(--border-focus) 14%, transparent)' }}
          >
            <div
              style={{
                height: '100%',
                width: '38%',
                borderRadius: 9999,
                background: 'var(--border-focus)',
                animation: 'cl-indeterminate 1.15s ease-in-out infinite',
              }}
            />
          </div>
        )}
        <div className="mt-2 text-[10.5px] leading-snug" style={{ color: 'var(--text-muted)' }}>
          {phase === 'reconnecting'
            ? 'Connected — reopening the new address now.'
            : slow
              ? 'Taking longer than usual. The new server may still be starting — this tab will switch over as soon as it answers.'
              : 'This tab reloads automatically once the new server answers.'}
        </div>
        {origin && (slow || phase === 'reconnecting') && (
          <a
            href={origin}
            className="mt-1.5 inline-flex items-center gap-1 text-[11px] font-medium"
            style={{ color: 'var(--border-focus)', fontFamily: 'var(--font-mono)' }}
          >
            Open {origin}
            <span aria-hidden="true">→</span>
          </a>
        )}
      </div>
    </div>
  )
}

function RestartStepGlyph({ state }: { state: 'done' | 'active' | 'pending' }) {
  if (state === 'done') {
    return (
      <span
        aria-hidden="true"
        className="inline-flex items-center justify-center rounded-full"
        style={{ width: 14, height: 14, background: 'var(--border-focus)', color: '#fff', fontSize: 9, fontWeight: 700 }}
      >
        ✓
      </span>
    )
  }
  if (state === 'active') {
    return (
      <span
        aria-hidden="true"
        className="inline-block rounded-full"
        style={{
          width: 14,
          height: 14,
          border: '1.5px solid color-mix(in srgb, var(--border-focus) 25%, transparent)',
          borderTopColor: 'var(--border-focus)',
          animation: 'cl-spin 0.7s linear infinite',
        }}
      />
    )
  }
  return (
    <span
      aria-hidden="true"
      className="inline-block rounded-full"
      style={{ width: 14, height: 14, border: '1.5px solid var(--border-default)' }}
    />
  )
}
