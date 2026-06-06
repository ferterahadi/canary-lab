import { useEffect, useState } from 'react'
import * as api from '../api/client'
import type { EditorChoice, HealAgentChoice, ProjectConfig } from '../api/client'
import { CloseIcon } from './config/atoms'
import { FolderPicker } from './config/FolderPicker'

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

// Poll the new origin until it answers, then navigate the tab to it. The old
// server shuts down ~moments after the port change, and the new one needs a
// beat to bind, so an immediate redirect could hit a dead port.
function defaultRedirect(newOrigin: string): void {
  let tries = 0
  const tick = (): void => {
    tries += 1
    fetch(`${newOrigin}/api/project-config`)
      .then((r) => {
        if (r.ok) { window.location.href = newOrigin; return }
        throw new Error('not ready')
      })
      .catch(() => {
        if (tries < 40) setTimeout(tick, 500)
        else window.location.href = newOrigin
      })
  }
  tick()
}

interface Props {
  onClose: () => void
  // Injected in tests; production polls the new origin then navigates the tab.
  onRedirect?: (url: string) => void
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
  const [restarting, setRestarting] = useState(false)

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
        setRestarting(true)
        redirect(res.newOrigin)
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
              <div className="mt-4 text-[10px] uppercase tracking-wider mb-2" style={{ color: 'var(--text-muted)' }}>
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
              {restarting && (
                <div className="mt-2 text-xs" style={{ color: 'var(--text-muted)' }}>
                  Restarting on the new port…
                </div>
              )}
              {portError && (
                <div className="mt-1 text-xs" style={{ color: 'var(--danger)' }}>{portError}</div>
              )}
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
