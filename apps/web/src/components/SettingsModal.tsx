import { useEffect, useState } from 'react'
import * as api from '../api/client'
import type { EditorChoice, HealAgentChoice, ProjectConfig } from '../api/client'

const HEAL_AGENT_OPTIONS: { value: HealAgentChoice; label: string; description: string }[] = [
  {
    value: 'auto',
    label: 'Auto-detect',
    description: 'Prefer Claude when available, fall back to Codex.',
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
  {
    value: 'manual',
    label: 'Manual',
    description: 'Skip auto-heal. Open Claude/Codex desktop yourself when a run pauses.',
  },
]

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

interface Props {
  onClose: () => void
}

export function SettingsModal({ onClose }: Props) {
  const [config, setConfig] = useState<ProjectConfig | null>(null)
  const [draft, setDraft] = useState<ProjectConfig | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let cancelled = false
    api.getProjectConfig()
      .then((c) => { if (!cancelled) { setConfig(c); setDraft(c) } })
      .catch((e: unknown) => {
        if (cancelled) return
        setError(e instanceof Error ? e.message : 'Failed to load settings')
      })
    return () => { cancelled = true }
  }, [])

  const dirty = draft != null && config != null
    && (draft.healAgent !== config.healAgent || draft.editor !== config.editor)

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

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.5)' }}
      onClick={onClose}
    >
      <div
        className="relative w-[480px] rounded-md"
        style={{
          background: 'var(--bg-base)',
          border: '1px solid var(--border-default)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3" style={{ borderBottom: '1px solid var(--border-default)' }}>
          <span className="text-[10px] uppercase tracking-wider font-medium" style={{ color: 'var(--text-muted)' }}>
            Settings
          </span>
          <button
            type="button"
            aria-label="Close settings"
            onClick={onClose}
            className="text-xs"
            style={{ color: 'var(--text-muted)' }}
          >
            ✕
          </button>
        </div>
        <div className="px-4 py-3">
          {!draft ? (
            <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
              {error ?? 'Loading…'}
            </div>
          ) : (
            <>
              <div className="text-[10px] uppercase tracking-wider mb-2" style={{ color: 'var(--text-muted)' }}>
                Heal agent
              </div>
              <div className="flex flex-col gap-1.5">
                {HEAL_AGENT_OPTIONS.map((opt) => (
                  <label
                    key={opt.value}
                    className="flex items-start gap-2 cursor-pointer rounded-md px-2 py-1.5"
                    style={{
                      background: draft.healAgent === opt.value ? 'var(--bg-elevated)' : 'transparent',
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
                    className="flex items-start gap-2 cursor-pointer rounded-md px-2 py-1.5"
                    style={{
                      background: draft.editor === opt.value ? 'var(--bg-elevated)' : 'transparent',
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
              <div className="mt-2 text-[10px]" style={{ color: 'var(--text-muted)' }}>
                Stored in <code>canary-lab.config.json</code> at the project root.
              </div>
            </>
          )}
        </div>
        <div className="flex items-center justify-end gap-2 px-4 py-3" style={{ borderTop: '1px solid var(--border-default)' }}>
          {error && <span className="mr-auto text-xs" style={{ color: '#ef4444' }}>{error}</span>}
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-1 text-xs"
            style={{ color: 'var(--text-muted)' }}
          >
            Close
          </button>
          <button
            type="button"
            onClick={onSave}
            disabled={!dirty || saving}
            className="rounded-md px-3 py-1 text-xs"
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
