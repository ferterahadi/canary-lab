import { useEffect, useState } from 'react'
import * as api from '@/shared/api/client'
import { FieldRow, Modal, TextInput } from '@/shared/ui/atoms'
import { FileBrowserList } from './FolderPicker'

export const inlineSelectStyle = {
  backgroundColor: 'var(--bg-elevated)',
  border: '1px solid var(--border-default)',
  color: 'var(--text-primary)',
  fontFamily: 'var(--font-mono)',
} as const

export function AddSlotModal({
  feature,
  envCount,
  onClose,
  onAdded,
}: {
  feature: string
  envCount: number
  onClose: () => void
  onAdded: (slot: string) => void | Promise<void>
}) {
  const [stage, setStage] = useState<'pick' | 'confirm'>('pick')
  const [browse, setBrowse] = useState<api.FsBrowseResponse | null>(null)
  const [pathInput, setPathInput] = useState('')
  const [picked, setPicked] = useState<string | null>(null)
  const [slotName, setSlotName] = useState('')
  const [target, setTarget] = useState('')
  const [description, setDescription] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const loadDir = async (dir: string): Promise<void> => {
    setError(null)
    try {
      const res = await api.browseDir(dir)
      setBrowse(res)
      setPathInput(res.dir)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Browse failed')
    }
  }

  useEffect(() => { loadDir('') }, [])

  const onPickFile = (full: string): void => {
    const name = full.split('/').pop() ?? full
    setPicked(full)
    setSlotName(name)
    setTarget(full)
    setStage('confirm')
  }

  const onSubmit = async (): Promise<void> => {
    if (!picked) return
    setBusy(true)
    setError(null)
    try {
      const res = await api.addEnvsetSlot(feature, {
        sourcePath: picked,
        slotName: slotName.trim() || undefined,
        target: target.trim() || undefined,
        description: description.trim() || undefined,
      })
      await onAdded(res.slot)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Add slot failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open={true} onClose={onClose} title="Add slot" width={600}>
      {envCount === 0 ? (
        <div className="px-4 py-4 text-xs" style={{ color: 'var(--text-muted)' }}>
          Create at least one env first, then add a slot.
        </div>
      ) : stage === 'pick' ? (
        <div className="flex flex-col">
          <div className="px-4 py-2 text-[11px]" style={{ color: 'var(--text-muted)' }}>
            Pick the file you want to track. Any file type works (.env, .properties, .json — anything).
            Its content will be copied into every existing env ({envCount} env{envCount === 1 ? '' : 's'}); you can edit each env's copy independently afterward.
          </div>
          <div className="flex items-center gap-1.5 px-4 pb-2">
            <TextInput
              value={pathInput}
              onChange={setPathInput}
              placeholder="/absolute/path or ~/path"
            />
            <button
              type="button"
              onClick={() => loadDir(pathInput)}
              className="cl-button rounded-md px-2 py-1 text-[10px] uppercase tracking-wider"
            >
              Go
            </button>
          </div>
          <div className="mx-4 mb-3">
            <FileBrowserList browse={browse} onNavigate={loadDir} onPickFile={onPickFile} />
          </div>
          {error && <div className="px-4 pb-2 text-xs" style={{ color: 'var(--danger)' }}>{error}</div>}
        </div>
      ) : (
        <div className="flex flex-col gap-3 px-4 py-3">
          <FieldRow label="Source">
            <div
              className="rounded-md px-2.5 py-1.5 text-xs truncate"
              style={{
                background: 'var(--bg-elevated)',
                border: '1px solid var(--border-default)',
                color: 'var(--text-muted)',
                fontFamily: 'var(--font-mono)',
              }}
              title={picked ?? ''}
            >
              {picked}
            </div>
          </FieldRow>
          <FieldRow label="Slot name" hint="Filename used inside envsets/<env>/">
            <TextInput value={slotName} onChange={setSlotName} />
          </FieldRow>
          <FieldRow label="Replaces" hint="Absolute path on this machine that the slot replaces at apply time">
            <TextInput value={target} onChange={setTarget} />
          </FieldRow>
          <FieldRow label="Description (optional)">
            <TextInput value={description} onChange={setDescription} />
          </FieldRow>
          <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
            The picked file's content will be copied into every existing env ({envCount}). Edit per-env afterward.
          </div>
          {error && <div className="text-xs" style={{ color: 'var(--danger)' }}>{error}</div>}
          <div className="flex justify-end gap-2 pt-2" style={{ borderTop: '1px solid var(--border-default)' }}>
            <button
              type="button"
              onClick={() => { setStage('pick'); setError(null) }}
              disabled={busy}
              className="cl-button rounded-md px-3 py-1 text-[11px] uppercase tracking-wider"
            >
              Back
            </button>
            <button
              type="button"
              onClick={onSubmit}
              disabled={busy || !slotName.trim() || !target.trim()}
              className="cl-button rounded-md px-3 py-1 text-[11px] uppercase tracking-wider"
            >
              {busy ? '…' : 'Add slot'}
            </button>
          </div>
        </div>
      )}
    </Modal>
  )
}
