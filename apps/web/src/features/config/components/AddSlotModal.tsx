import { useRef, useState } from 'react'
import * as configApi from '@/shared/api/config'
import { FieldRow, TextInput } from '@/shared/ui/FormFields'
import { Modal } from '@/shared/ui/Overlays'
import { useMountedIdentity } from '@/shared/state/use-mounted-identity'
import { useFilesystemBrowser } from './use-filesystem-browser'
import { FileBrowserList } from './FolderPicker'
import { displayError } from '@/shared/api/error-message'
import { plural } from '@shared/lib/plural'

export const inlineSelectStyle = {
  backgroundColor: 'var(--bg-elevated)',
  border: '1px solid var(--border-default)',
  color: 'var(--text-primary)',
  fontFamily: 'var(--font-mono)',
} as const

export function AddSlotModal(props: Parameters<typeof AddSlotSession>[0]) {
  return <AddSlotSession key={props.feature} {...props} />
}

function AddSlotSession({
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
  const browser = useFilesystemBrowser({ session: feature, kind: 'files', enabled: stage === 'pick' && envCount > 0 })
  const { browse, pathInput, setPathInput, navigate: loadDir } = browser
  const current = useMountedIdentity(feature)
  const submitting = useRef(false)
  const [picked, setPicked] = useState<string | null>(null)
  const [slotName, setSlotName] = useState('')
  const [target, setTarget] = useState('')
  const [description, setDescription] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const onPickFile = (full: string): void => {
    if (!browser.confirmed) return
    const name = full.split('/').pop() ?? full
    setPicked(full)
    setSlotName(name)
    setTarget(full)
    setStage('confirm')
  }

  const onSubmit = async (): Promise<void> => {
    if (!picked || submitting.current) return
    submitting.current = true
    setBusy(true)
    setError(null)
    try {
      const res = await configApi.addEnvsetSlot(feature, {
        sourcePath: picked,
        slotName: slotName.trim() || undefined,
        target: target.trim() || undefined,
        description: description.trim() || undefined,
      })
      if (current()) await onAdded(res.slot)
    } catch (e: unknown) {
      if (current()) setError(displayError(e, 'Add slot failed'))
    } finally {
      submitting.current = false
      if (current()) setBusy(false)
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
            Its content will be copied into every existing env ({plural(envCount, 'env')}); you can edit each env's copy independently afterward.
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
            <FileBrowserList disabled={!browser.confirmed} browse={browse} onNavigate={loadDir} onPickFile={onPickFile} />
          </div>
          {(browser.loading || browser.error) && <div role="status" className="px-4 pb-2 text-xs text-muted">
            {browser.error || 'Loading directory…'} <span className="font-mono">{browser.requestedPath || '~'}</span> <button type="button" className="cl-button px-2" onClick={browser.retry}>Retry</button>
          </div>}
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
