import { useEffect, useState, type ReactNode } from 'react'
import * as api from '@/shared/api/client'
import { FieldRow, Modal, TextInput } from '@/shared/ui/atoms'
import { FileBrowserList } from './FolderPicker'
import { inlineSelectStyle } from './AddSlotModal'
import { KvEntry, diffKvEntries } from './envset-diff'

export function CopyFromModal({
  feature,
  targetEnv,
  slot,
  siblingEnvs,
  current,
  onClose,
  onApply,
}: {
  feature: string
  targetEnv: string
  slot: string
  siblingEnvs: string[]
  current: KvEntry[]
  onClose: () => void
  onApply: (merged: KvEntry[]) => void
}) {
  const [mode, setMode] = useState<'env' | 'file'>(siblingEnvs.length > 0 ? 'env' : 'file')
  const [sourceEnv, setSourceEnv] = useState<string | null>(siblingEnvs[0] ?? null)
  const [filePath, setFilePath] = useState('')
  const [browse, setBrowse] = useState<api.FsBrowseResponse | null>(null)
  const [sourceEntries, setSourceEntries] = useState<KvEntry[] | null>(null)
  const [sourceLabel, setSourceLabel] = useState<string>('')
  const [error, setError] = useState<string | null>(null)
  const [stage, setStage] = useState<'pick' | 'review'>('pick')
  const [overwrite, setOverwrite] = useState<Record<string, boolean>>({})
  const [addNew, setAddNew] = useState<Record<string, boolean>>({})
  const [keepExtra, setKeepExtra] = useState<Record<string, boolean>>({})
  const [busy, setBusy] = useState(false)

  const loadDir = async (dir: string): Promise<void> => {
    setError(null)
    try {
      const res = await api.browseDir(dir)
      setBrowse(res)
      setFilePath(res.dir)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Browse failed')
    }
  }

  useEffect(() => {
    if (mode === 'file' && !browse) loadDir('')
  }, [mode])

  const applyEntries = (entries: KvEntry[], label: string): void => {
    setSourceEntries(entries)
    setSourceLabel(label)
    const diff = diffKvEntries(entries, current)
    setOverwrite(Object.fromEntries(diff.matching.map((m) => [m.key, true])))
    setAddNew(Object.fromEntries(diff.onlyInSource.map((m) => [m.key, true])))
    setKeepExtra(Object.fromEntries(diff.onlyInCurrent.map((m) => [m.key, true])))
    setStage('review')
  }

  const onLoadEnv = async (): Promise<void> => {
    if (!sourceEnv) return
    setBusy(true)
    setError(null)
    try {
      const doc = await api.getEnvsetSlot(feature, sourceEnv, slot)
      applyEntries(doc.entries, sourceEnv)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Load failed')
    } finally {
      setBusy(false)
    }
  }

  const onLoadFile = async (full: string): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const res = await api.readDotenvFile(full)
      applyEntries(res.entries, full)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Read failed')
    } finally {
      setBusy(false)
    }
  }

  const diff = sourceEntries ? diffKvEntries(sourceEntries, current) : null

  const onConfirm = (): void => {
    if (!diff) return
    const matchValue = new Map(diff.matching.map((m) => [m.key, m]))
    const merged: KvEntry[] = []
    for (const entry of current) {
      if (!entry.key) { merged.push(entry); continue }
      const m = matchValue.get(entry.key)
      if (m) {
        merged.push({ key: entry.key, value: overwrite[entry.key] ? m.sourceValue : entry.value })
      } else if (keepExtra[entry.key]) {
        merged.push(entry)
      }
    }
    for (const e of diff.onlyInSource) {
      if (addNew[e.key]) merged.push({ key: e.key, value: e.value })
    }
    onApply(merged)
  }

  return (
    <Modal open={true} onClose={onClose} title={`Copy from… → ${targetEnv}`} width={640}>
      {stage === 'pick' ? (
        <div className="flex flex-col gap-3 px-4 py-3">
          <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
            Pick a source to seed values from — another env in this suite, or any .env file on disk. Keys will be compared and you&apos;ll review the diff before anything is written into this editor&apos;s draft.
          </div>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => { if (siblingEnvs.length > 0) setMode('env') }}
              disabled={siblingEnvs.length === 0}
              className="cl-button rounded-md px-2 py-1 text-[10px] uppercase tracking-wider"
              style={{
                color: mode === 'env' ? 'var(--text-primary)' : undefined,
                borderColor: mode === 'env' ? 'var(--text-primary)' : undefined,
              }}
            >
              From env
            </button>
            <button
              type="button"
              onClick={() => setMode('file')}
              className="cl-button rounded-md px-2 py-1 text-[10px] uppercase tracking-wider"
              style={{
                color: mode === 'file' ? 'var(--text-primary)' : undefined,
                borderColor: mode === 'file' ? 'var(--text-primary)' : undefined,
              }}
            >
              From file
            </button>
          </div>
          {mode === 'env' ? (
            <FieldRow label="Source env">
              <select
                value={sourceEnv ?? ''}
                onChange={(e) => setSourceEnv(e.target.value)}
                className="themed-select w-full rounded-md py-1.5 pl-2.5 pr-8 text-xs outline-none"
                style={inlineSelectStyle}
              >
                {siblingEnvs.map((n) => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
            </FieldRow>
          ) : (
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-1.5">
                <TextInput
                  value={filePath}
                  onChange={setFilePath}
                  placeholder="/absolute/path/to/.env or ~/path"
                />
                <button
                  type="button"
                  onClick={() => loadDir(filePath)}
                  className="cl-button rounded-md px-2 py-1 text-[10px] uppercase tracking-wider"
                >
                  Go
                </button>
              </div>
              <FileBrowserList browse={browse} onNavigate={loadDir} onPickFile={onLoadFile} minHeight={200} maxHeightVh={40} />
              <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                Click a file to load it. Anything parseable as <code>KEY=VALUE</code> works.
              </div>
            </div>
          )}
          {error && <div className="text-xs" style={{ color: 'var(--danger)' }}>{error}</div>}
          <div className="flex justify-end gap-2 pt-2" style={{ borderTop: '1px solid var(--border-default)' }}>
            <button
              type="button"
              onClick={onClose}
              className="rounded-md px-3 py-1 text-[11px] uppercase tracking-wider"
              style={{ color: 'var(--text-muted)' }}
            >
              Cancel
            </button>
            {mode === 'env' && (
              <button
                type="button"
                onClick={onLoadEnv}
                disabled={busy || !sourceEnv}
                className="rounded-md px-3 py-1 text-[11px] uppercase tracking-wider"
                style={{ color: 'var(--text-primary)', border: '1px solid var(--border-default)' }}
              >
                {busy ? '…' : 'Compare'}
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="flex max-h-[70vh] flex-col">
          <div className="px-4 py-2 text-[11px]" style={{ color: 'var(--text-muted)' }}>
            Comparing <code style={{ fontFamily: 'var(--font-mono)' }}>{sourceLabel}</code> → <code style={{ fontFamily: 'var(--font-mono)' }}>{targetEnv}</code>. Toggle which keys to apply, then confirm. Nothing is saved to disk until you hit SAVE.
          </div>
          <div className="flex-1 overflow-y-auto scrollbar-thin px-4 pb-3">
            <DiffSection
              title={`Matching keys (${diff?.matching.length ?? 0})`}
              hint={`Overwrite current values from ${sourceLabel}`}
              empty="No keys exist in both envs."
              rows={(diff?.matching ?? []).map((m) => ({
                key: m.key,
                checked: !!overwrite[m.key],
                onToggle: () => setOverwrite((s) => ({ ...s, [m.key]: !s[m.key] })),
                detail: (
                  <span className="text-[10px]" style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                    <span style={{ color: 'var(--danger)' }}>{m.currentValue || '∅'}</span>
                    {' → '}
                    <span style={{ color: 'var(--success)' }}>{m.sourceValue || '∅'}</span>
                  </span>
                ),
              }))}
            />
            <DiffSection
              title={`Only in source (${diff?.onlyInSource.length ?? 0})`}
              hint={`Add to ${targetEnv}?`}
              empty="No keys exclusive to source."
              rows={(diff?.onlyInSource ?? []).map((e) => ({
                key: e.key,
                checked: !!addNew[e.key],
                onToggle: () => setAddNew((s) => ({ ...s, [e.key]: !s[e.key] })),
                detail: (
                  <span className="text-[10px]" style={{ color: 'var(--success)', fontFamily: 'var(--font-mono)' }}>
                    {e.value || '∅'}
                  </span>
                ),
              }))}
            />
            <DiffSection
              title={`Only in ${targetEnv} (${diff?.onlyInCurrent.length ?? 0})`}
              hint={`Not present in ${sourceLabel} — is this expected? Uncheck to drop.`}
              empty={`No keys exclusive to ${targetEnv}.`}
              rows={(diff?.onlyInCurrent ?? []).map((e) => ({
                key: e.key,
                checked: !!keepExtra[e.key],
                onToggle: () => setKeepExtra((s) => ({ ...s, [e.key]: !s[e.key] })),
                detail: (
                  <span className="text-[10px]" style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                    {e.value || '∅'}
                  </span>
                ),
              }))}
            />
          </div>
          <div className="flex justify-end gap-2 px-4 py-2" style={{ borderTop: '1px solid var(--border-default)' }}>
            <button
              type="button"
              onClick={() => setStage('pick')}
              className="rounded-md px-3 py-1 text-[11px] uppercase tracking-wider"
              style={{ color: 'var(--text-muted)', border: '1px solid var(--border-default)' }}
            >
              Back
            </button>
            <button
              type="button"
              onClick={onConfirm}
              className="rounded-md px-3 py-1 text-[11px] uppercase tracking-wider"
              style={{ color: 'var(--text-primary)', border: '1px solid var(--border-default)' }}
            >
              Apply
            </button>
          </div>
        </div>
      )}
    </Modal>
  )
}

export function DiffSection({
  title,
  hint,
  empty,
  rows,
}: {
  title: string
  hint: string
  empty: string
  rows: { key: string; checked: boolean; onToggle: () => void; detail: ReactNode }[]
}) {
  return (
    <div className="mt-3">
      <div className="flex items-baseline justify-between">
        <span className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>{title}</span>
        <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{hint}</span>
      </div>
      <div className="mt-1 rounded-md" style={{ border: '1px solid var(--border-default)' }}>
        {rows.length === 0 ? (
          <div className="px-3 py-2 text-[11px]" style={{ color: 'var(--text-muted)' }}>{empty}</div>
        ) : rows.map((r) => (
          <label key={r.key} className="flex items-center gap-2 px-3 py-1.5 text-xs cursor-pointer" style={{ borderBottom: '1px solid var(--border-default)' }}>
            <input type="checkbox" checked={r.checked} onChange={r.onToggle} />
            <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-primary)' }}>{r.key}</span>
            <span className="ml-auto truncate max-w-[55%]">{r.detail}</span>
          </label>
        ))}
      </div>
    </div>
  )
}
