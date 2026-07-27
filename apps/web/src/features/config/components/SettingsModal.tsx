import { useEffect, useState } from 'react'
import * as api from '@/shared/api/client'
import type { ProjectConfig } from '@/shared/api/client'
import { Modal } from '@/shared/ui/atoms'
import { FolderPicker } from './FolderPicker'
import { GitHubSection } from './GitHubSection'
import { RestartPhase, RestartProgress, defaultRedirect } from './SettingsRestartProgress'
import { DEFAULT_PORT, EDITOR_OPTIONS, HEAL_AGENT_OPTIONS, migrateLegacyHealAgent } from './settings-options'

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
    <Modal
      open
      onClose={onClose}
      title="Project Settings"
      ariaLabel="Project Settings"
      footer={
        <>
          {error && <span className="mr-auto text-xs" style={{ color: 'var(--danger)' }}>{error}</span>}
          <button type="button" onClick={onClose} className="cl-button px-3 py-1 text-xs">
            Close
          </button>
          <button
            type="button"
            onClick={onSave}
            disabled={!dirty || saving}
            className="cl-button px-3 py-1 text-xs"
            style={{
              color: dirty ? 'var(--accent)' : 'var(--text-muted)',
              border: '1px solid',
              borderColor: dirty ? 'color-mix(in srgb, var(--accent) 40%, transparent)' : 'var(--border-default)',
              background: dirty ? 'color-mix(in srgb, var(--accent) 8%, transparent)' : 'transparent',
              opacity: saving ? 0.6 : 1,
            }}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
        <div className="min-h-0 px-4 py-3">
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
                  style={{ background: 'var(--bg-elevated)', color: 'var(--text-primary)', border: '1px solid var(--border-default)' }}
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
                Default agent
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
                GitHub
              </div>
              <GitHubSection />
            </>
          )}
        </div>
    </Modal>
  )
}
