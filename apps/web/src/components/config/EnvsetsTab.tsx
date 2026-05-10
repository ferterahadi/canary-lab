import { useEffect, useState, type ReactNode } from 'react'
import * as api from '../../api/client'
import { ConfirmModal, FieldRow, FolderIcon, HintIcon, IconButton, Modal, PlusIcon, SectionHeader, TextInput, TrashIcon } from './atoms'
import { SaveBar } from './SaveBar'

const NEW_ENV_SENTINEL = '__new_env__'
const NEW_SLOT_SENTINEL = '__new_slot__'

const inlineSelectStyle = {
  backgroundColor: 'var(--bg-elevated)',
  border: '1px solid var(--border-default)',
  color: 'var(--text-primary)',
  fontFamily: 'var(--font-mono)',
} as const

interface KvEntry { key: string; value: string }

function stripFeaturePrefix(slot: string, feature: string): string {
  return slot.startsWith(`${feature}.`) ? slot.slice(feature.length + 1) : slot
}

interface KvDiff {
  matching: { key: string; sourceValue: string; currentValue: string }[]
  onlyInSource: { key: string; value: string }[]
  onlyInCurrent: { key: string; value: string }[]
}

function diffKvEntries(source: KvEntry[], current: KvEntry[]): KvDiff {
  const sourceMap = new Map(source.map((e) => [e.key, e.value]))
  const currentKeys = new Set(current.map((e) => e.key))
  const matching: KvDiff['matching'] = []
  const onlyInCurrent: KvDiff['onlyInCurrent'] = []
  for (const entry of current) {
    if (!entry.key) continue
    if (sourceMap.has(entry.key)) {
      matching.push({ key: entry.key, sourceValue: sourceMap.get(entry.key)!, currentValue: entry.value })
    } else {
      onlyInCurrent.push({ key: entry.key, value: entry.value })
    }
  }
  const onlyInSource: KvDiff['onlyInSource'] = source
    .filter((e) => e.key && !currentKeys.has(e.key))
    .map((e) => ({ key: e.key, value: e.value }))
  return { matching, onlyInSource, onlyInCurrent }
}


export function EnvsetsTab({ feature }: { feature: string }) {
  const [index, setIndex] = useState<api.EnvsetIndex | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [env, setEnv] = useState<string | null>(null)
  const [slot, setSlot] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [newEnvName, setNewEnvName] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirmDeleteEnv, setConfirmDeleteEnv] = useState<string | null>(null)
  const [confirmDeleteSlot, setConfirmDeleteSlot] = useState<string | null>(null)
  const [addSlotOpen, setAddSlotOpen] = useState(false)

  const refresh = (): Promise<void> =>
    api.getEnvsetsIndex(feature)
      .then((idx) => { setIndex(idx); setError(null) })
      .catch((e: unknown) => { setError(e instanceof Error ? e.message : 'Failed to load envsets') })

  useEffect(() => {
    let cancelled = false
    api.getEnvsetsIndex(feature)
      .then((idx) => {
        if (cancelled) return
        setIndex(idx)
        setError(null)
        if (!env && idx.envs.length > 0) {
          setEnv(idx.envs[0].name)
          setSlot(idx.envs[0].slots[0] ?? null)
        }
      })
      .catch((e: unknown) => {
        if (cancelled) return
        setError(e instanceof Error ? e.message : 'Failed to load envsets')
      })
    return () => { cancelled = true }
  }, [feature])

  const onAddEnv = async (): Promise<void> => {
    const name = newEnvName.trim()
    if (!name) return
    setBusy(true)
    setError(null)
    try {
      await api.createEnvset(feature, name)
      setAdding(false)
      setNewEnvName('')
      await refresh()
      setEnv(name)
      const fresh = await api.getEnvsetsIndex(feature)
      const created = fresh.envs.find((e) => e.name === name)
      setSlot(created?.slots[0] ?? null)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Create failed')
    } finally {
      setBusy(false)
    }
  }

  const onDeleteEnv = async (name: string): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await api.deleteEnvset(feature, name)
      await refresh()
      setEnv(null)
      setSlot(null)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Delete failed')
    } finally {
      setBusy(false)
      setConfirmDeleteEnv(null)
    }
  }

  const onDeleteSlot = async (slotName: string): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await api.deleteEnvsetSlot(feature, slotName)
      const fresh = await api.getEnvsetsIndex(feature)
      setIndex(fresh)
      const currentEnv = fresh.envs.find((e) => e.name === env) ?? fresh.envs[0]
      setSlot(currentEnv?.slots[0] ?? null)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Delete failed')
    } finally {
      setBusy(false)
      setConfirmDeleteSlot(null)
    }
  }

  const onSlotAdded = async (slotName: string): Promise<void> => {
    const fresh = await api.getEnvsetsIndex(feature)
    setIndex(fresh)
    setAddSlotOpen(false)
    setSlot(slotName)
  }

  if (error && !index) {
    return <div className="p-4 text-xs" style={{ color: 'var(--text-muted)' }}>{error}</div>
  }
  if (!index) {
    return <div className="p-4 text-xs" style={{ color: 'var(--text-muted)' }}>Loading…</div>
  }

  const envObj = index.envs.find((e) => e.name === env) ?? index.envs[0]
  const slotName = envObj && slot && envObj.slots.includes(slot) ? slot : envObj?.slots[0]

  const slotTarget = slotName ? index.slotTargets?.[slotName] : undefined

  return (
    <div className="flex h-full flex-col">
      <div
        className="px-4 py-2 text-[11px]"
        style={{ color: 'var(--text-muted)', borderBottom: '1px solid var(--border-default)' }}
      >
        Envsets temporarily replace environment files in the linked repos during a run. Pick an env, then edit each slot's values.
      </div>
      <div
        className="flex flex-col gap-1 px-4 py-3"
        style={{ borderBottom: '1px solid var(--border-default)' }}
      >
        {index.envs.length === 0 || !envObj ? (
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
              No envs yet. Create one to get started.
            </span>
            <NewEnvControl
              adding={adding}
              busy={busy}
              newEnvName={newEnvName}
              setNewEnvName={setNewEnvName}
              setAdding={setAdding}
              onAddEnv={onAddEnv}
            />
          </div>
        ) : (
          <>
            <FieldRow label="Env" layout="inline">
              <div className="flex items-center justify-between gap-1.5">
                {adding ? (
                  <NewEnvControl
                    adding={adding}
                    busy={busy}
                    newEnvName={newEnvName}
                    setNewEnvName={setNewEnvName}
                    setAdding={setAdding}
                    onAddEnv={onAddEnv}
                  />
                ) : (
                  <select
                    value={envObj.name}
                    onChange={(e) => {
                      const v = e.target.value
                      if (v === NEW_ENV_SENTINEL) {
                        setAdding(true)
                        return
                      }
                      setEnv(v)
                      const next = index.envs.find((e2) => e2.name === v)
                      setSlot(next?.slots[0] ?? null)
                    }}
                    className="themed-select w-44 rounded-md py-1.5 pl-2.5 pr-8 text-xs outline-none"
                    style={inlineSelectStyle}
                  >
                    {index.envs.map((e) => (
                      <option key={e.name} value={e.name}>{e.name}</option>
                    ))}
                    <option disabled>──────────</option>
                    <option value={NEW_ENV_SENTINEL}>+ New env…</option>
                  </select>
                )}
                <IconButton
                  ariaLabel="Delete env"
                  variant="danger"
                  onClick={() => { if (!busy) setConfirmDeleteEnv(envObj.name) }}
                >
                  <TrashIcon />
                </IconButton>
              </div>
            </FieldRow>
            <FieldRow
              label="Slot"
              layout="inline"
              hint={slotName ? index.slotDescriptions[slotName] : undefined}
            >
              <div className="flex items-center justify-between gap-1.5">
                <div className="flex items-center gap-2">
                  <select
                    value={slotName ?? ''}
                    onChange={(e) => {
                      const v = e.target.value
                      if (v === NEW_SLOT_SENTINEL) {
                        setAddSlotOpen(true)
                        return
                      }
                      setSlot(v)
                    }}
                    className="themed-select w-44 rounded-md py-1.5 pl-2.5 pr-8 text-xs outline-none"
                    style={inlineSelectStyle}
                  >
                    {!slotName && <option value="" disabled>No slots yet</option>}
                    {envObj.slots.map((s) => (
                      <option key={s} value={s}>{stripFeaturePrefix(s, feature)}</option>
                    ))}
                    {envObj.slots.length > 0 && <option disabled>──────────</option>}
                    <option value={NEW_SLOT_SENTINEL}>+ New slot…</option>
                  </select>
                  {slotTarget ? (
                    <HintIcon
                      label="Replaces path"
                      hint={`Replaces: ${slotTarget}`}
                      icon={<FolderIcon />}
                    />
                  ) : null}
                </div>
                {slotName ? (
                  <IconButton
                    ariaLabel="Delete slot"
                    variant="danger"
                    onClick={() => { if (!busy) setConfirmDeleteSlot(slotName) }}
                  >
                    <TrashIcon />
                  </IconButton>
                ) : null}
              </div>
            </FieldRow>
          </>
        )}
      </div>
      {error && (
        <div className="px-4 py-1.5 text-xs" style={{ color: '#ef4444' }}>{error}</div>
      )}
      {envObj && slotName ? (
        <SlotEditor
          key={`${envObj.name}/${slotName}`}
          feature={feature}
          env={envObj.name}
          slot={slotName}
          siblingEnvs={index.envs.filter((e) => e.name !== envObj.name && e.slots.includes(slotName)).map((e) => e.name)}
        />
      ) : envObj ? (
        <div className="p-4 text-xs" style={{ color: 'var(--text-muted)' }}>No slots in this env.</div>
      ) : null}
      <ConfirmModal
        open={confirmDeleteEnv !== null}
        title="Delete env"
        message={
          <>
            Delete env <code style={{ fontFamily: 'var(--font-mono)' }}>{confirmDeleteEnv}</code>?
            This removes the folder and all its slot files. This cannot be undone.
          </>
        }
        confirmLabel="Delete"
        variant="danger"
        busy={busy}
        onCancel={() => setConfirmDeleteEnv(null)}
        onConfirm={() => { if (confirmDeleteEnv) onDeleteEnv(confirmDeleteEnv) }}
      />
      <ConfirmModal
        open={confirmDeleteSlot !== null}
        title="Delete slot"
        message={
          <>
            Delete slot <code style={{ fontFamily: 'var(--font-mono)' }}>{confirmDeleteSlot}</code>?
            This removes the file from every env and from <code>envsets.config.json</code>.
          </>
        }
        confirmLabel="Delete"
        variant="danger"
        busy={busy}
        onCancel={() => setConfirmDeleteSlot(null)}
        onConfirm={() => { if (confirmDeleteSlot) onDeleteSlot(confirmDeleteSlot) }}
      />
      {addSlotOpen && (
        <AddSlotModal
          feature={feature}
          envCount={index.envs.length}
          onClose={() => setAddSlotOpen(false)}
          onAdded={onSlotAdded}
        />
      )}
    </div>
  )
}

function AddSlotModal({
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

  const onPickFile = (name: string): void => {
    if (!browse) return
    const full = `${browse.dir}/${name}`.replace(/\/+/g, '/')
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
              className="rounded-md px-2 py-1 text-[10px] uppercase tracking-wider"
              style={{ color: 'var(--text-primary)', border: '1px solid var(--border-default)' }}
            >
              Go
            </button>
          </div>
          <div
            className="mx-4 mb-3 max-h-[50vh] min-h-[260px] overflow-y-auto scrollbar-thin rounded-md"
            style={{ border: '1px solid var(--border-default)' }}
          >
            {browse?.parent && (
              <button
                type="button"
                onClick={() => loadDir(browse.parent!)}
                className="block w-full truncate px-3 py-1.5 text-left text-xs"
                style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}
              >
                ../
              </button>
            )}
            {browse?.entries.map((e) => (
              <button
                key={e.name}
                type="button"
                onClick={() => e.isDir ? loadDir(`${browse.dir}/${e.name}`.replace(/\/+/g, '/')) : onPickFile(e.name)}
                className="block w-full truncate px-3 py-1.5 text-left text-xs hover:opacity-80"
                style={{
                  color: e.isDir ? 'var(--text-primary)' : 'var(--text-secondary)',
                  fontFamily: 'var(--font-mono)',
                }}
              >
                {e.isDir ? `${e.name}/` : e.name}
              </button>
            ))}
            {browse && browse.entries.length === 0 && (
              <div className="px-3 py-2 text-xs" style={{ color: 'var(--text-muted)' }}>Empty directory.</div>
            )}
          </div>
          {error && <div className="px-4 pb-2 text-xs" style={{ color: '#ef4444' }}>{error}</div>}
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
          {error && <div className="text-xs" style={{ color: '#ef4444' }}>{error}</div>}
          <div className="flex justify-end gap-2 pt-2" style={{ borderTop: '1px solid var(--border-default)' }}>
            <button
              type="button"
              onClick={() => { setStage('pick'); setError(null) }}
              disabled={busy}
              className="rounded-md px-3 py-1 text-[11px] uppercase tracking-wider"
              style={{ color: 'var(--text-muted)', border: '1px solid var(--border-default)' }}
            >
              Back
            </button>
            <button
              type="button"
              onClick={onSubmit}
              disabled={busy || !slotName.trim() || !target.trim()}
              className="rounded-md px-3 py-1 text-[11px] uppercase tracking-wider"
              style={{ color: 'var(--text-primary)', border: '1px solid var(--border-default)' }}
            >
              {busy ? '…' : 'Add slot'}
            </button>
          </div>
        </div>
      )}
    </Modal>
  )
}

function SlotEditor({
  feature,
  env,
  slot,
  siblingEnvs,
}: {
  feature: string
  env: string
  slot: string
  siblingEnvs: string[]
}) {
  const [doc, setDoc] = useState<api.EnvsetSlotDoc | null>(null)
  const [draft, setDraft] = useState<KvEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const [copyOpen, setCopyOpen] = useState(false)

  useEffect(() => {
    let cancelled = false
    api.getEnvsetSlot(feature, env, slot)
      .then((d) => { if (!cancelled) { setDoc(d); setDraft(d.entries); setError(null) } })
      .catch((e: unknown) => {
        if (cancelled) return
        setError(e instanceof Error ? e.message : 'Failed to load')
      })
    return () => { cancelled = true }
  }, [feature, env, slot])

  if (error) return <div className="p-4 text-xs" style={{ color: 'var(--text-muted)' }}>{error}</div>
  if (!doc || !draft) return <div className="p-4 text-xs" style={{ color: 'var(--text-muted)' }}>Loading…</div>

  const dirty = JSON.stringify(draft) !== JSON.stringify(doc.entries)

  const onSave = async (): Promise<void> => {
    setSaving(true)
    setError(null)
    try {
      const next = await api.putEnvsetSlot(feature, env, slot, draft)
      setDoc(next)
      setDraft(next.entries)
      setSavedAt(Date.now())
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex h-full flex-1 min-h-0 flex-col">
      <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin">
        <SectionHeader>{slot}</SectionHeader>
        <div className="px-4 py-3 flex flex-col gap-1.5">
          {draft.map((entry, i) => (
            <div key={i} className="group flex items-center gap-1.5">
              <input
                type="text"
                value={entry.key}
                onChange={(e) => setDraft(draft.map((x, j) => j === i ? { ...x, key: e.target.value } : x))}
                placeholder="KEY"
                className="w-[40%] rounded-md px-2.5 py-1.5 text-xs outline-none"
                style={{
                  background: 'var(--bg-elevated)',
                  border: '1px solid var(--border-default)',
                  color: 'var(--text-primary)',
                  fontFamily: 'var(--font-mono)',
                }}
              />
              <span style={{ color: 'var(--text-muted)' }}>=</span>
              <div className="relative flex-1">
                <input
                  type="text"
                  value={entry.value}
                  onChange={(e) => setDraft(draft.map((x, j) => j === i ? { ...x, value: e.target.value } : x))}
                  className="w-full rounded-md py-1.5 pl-2.5 pr-8 text-xs outline-none focus:ring-1"
                  style={{
                    backgroundColor: 'var(--bg-elevated)',
                    border: '1px solid var(--border-default)',
                    color: 'var(--text-primary)',
                    fontFamily: 'var(--font-mono)',
                  }}
                />
                <button
                  type="button"
                  aria-label="Remove key"
                  title="Remove key"
                  onClick={() => setDraft(draft.filter((_, j) => j !== i))}
                  className="absolute right-1.5 top-1/2 inline-flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md opacity-0 transition-opacity duration-150 group-hover:opacity-100 focus:opacity-100"
                  style={{ color: '#ef4444' }}
                >
                  <TrashIcon />
                </button>
              </div>
            </div>
          ))}
          <div className="mt-1 flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setDraft([...draft, { key: '', value: '' }])}
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[10px] uppercase tracking-wider"
              style={{ color: 'var(--text-muted)', border: '1px dashed var(--border-default)' }}
            >
              <PlusIcon />
              Add entry
            </button>
            <button
              type="button"
              onClick={() => setCopyOpen(true)}
              title="Seed values from another env or a file"
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[10px] uppercase tracking-wider"
              style={{ color: 'var(--text-muted)', border: '1px dashed var(--border-default)' }}
            >
              Copy from…
            </button>
          </div>
          {doc.unparsedLines.length > 0 && (
            <div className="mt-3 text-[10px]" style={{ color: '#eab308' }}>
              {doc.unparsedLines.length} line(s) couldn't be parsed and will be preserved verbatim.
            </div>
          )}
        </div>
      </div>
      <SaveBar
        dirty={dirty}
        saving={saving}
        error={error}
        savedAt={savedAt}
        onSave={onSave}
        onDiscard={() => setDraft(doc.entries)}
      />
      {copyOpen && (
        <CopyFromModal
          feature={feature}
          targetEnv={env}
          slot={slot}
          siblingEnvs={siblingEnvs}
          current={draft}
          onClose={() => setCopyOpen(false)}
          onApply={(merged) => { setDraft(merged); setCopyOpen(false) }}
        />
      )}
    </div>
  )
}

function CopyFromModal({
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
            Pick a source to seed values from — another env in this feature, or any .env file on disk. Keys will be compared and you'll review the diff before anything is written into this editor's draft.
          </div>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => { if (siblingEnvs.length > 0) setMode('env') }}
              disabled={siblingEnvs.length === 0}
              className="rounded-md px-2 py-1 text-[10px] uppercase tracking-wider"
              style={{
                color: mode === 'env' ? 'var(--text-primary)' : 'var(--text-muted)',
                border: `1px solid ${mode === 'env' ? 'var(--text-primary)' : 'var(--border-default)'}`,
                opacity: siblingEnvs.length === 0 ? 0.4 : 1,
              }}
            >
              From env
            </button>
            <button
              type="button"
              onClick={() => setMode('file')}
              className="rounded-md px-2 py-1 text-[10px] uppercase tracking-wider"
              style={{
                color: mode === 'file' ? 'var(--text-primary)' : 'var(--text-muted)',
                border: `1px solid ${mode === 'file' ? 'var(--text-primary)' : 'var(--border-default)'}`,
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
                  className="rounded-md px-2 py-1 text-[10px] uppercase tracking-wider"
                  style={{ color: 'var(--text-primary)', border: '1px solid var(--border-default)' }}
                >
                  Go
                </button>
              </div>
              <div
                className="max-h-[40vh] min-h-[200px] overflow-y-auto scrollbar-thin rounded-md"
                style={{ border: '1px solid var(--border-default)' }}
              >
                {browse?.parent && (
                  <button
                    type="button"
                    onClick={() => loadDir(browse.parent!)}
                    className="block w-full truncate px-3 py-1.5 text-left text-xs"
                    style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}
                  >
                    ../
                  </button>
                )}
                {browse?.entries.map((e) => (
                  <button
                    key={e.name}
                    type="button"
                    onClick={() => {
                      const full = `${browse.dir}/${e.name}`.replace(/\/+/g, '/')
                      if (e.isDir) loadDir(full)
                      else onLoadFile(full)
                    }}
                    className="block w-full truncate px-3 py-1.5 text-left text-xs hover:opacity-80"
                    style={{
                      color: e.isDir ? 'var(--text-primary)' : 'var(--text-secondary)',
                      fontFamily: 'var(--font-mono)',
                    }}
                  >
                    {e.isDir ? `${e.name}/` : e.name}
                  </button>
                ))}
                {browse && browse.entries.length === 0 && (
                  <div className="px-3 py-2 text-xs" style={{ color: 'var(--text-muted)' }}>Empty directory.</div>
                )}
              </div>
              <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                Click a file to load it. Anything parseable as <code>KEY=VALUE</code> works.
              </div>
            </div>
          )}
          {error && <div className="text-xs" style={{ color: '#ef4444' }}>{error}</div>}
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
                    <span style={{ color: '#ef4444' }}>{m.currentValue || '∅'}</span>
                    {' → '}
                    <span style={{ color: '#22c55e' }}>{m.sourceValue || '∅'}</span>
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
                  <span className="text-[10px]" style={{ color: '#22c55e', fontFamily: 'var(--font-mono)' }}>
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

function DiffSection({
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

function NewEnvControl({
  adding,
  busy,
  newEnvName,
  setNewEnvName,
  setAdding,
  onAddEnv,
}: {
  adding: boolean
  busy: boolean
  newEnvName: string
  setNewEnvName: (v: string) => void
  setAdding: (v: boolean) => void
  onAddEnv: () => void
}) {
  if (adding) {
    return (
      <div className="flex items-center gap-1.5">
        <div className="w-44">
          <TextInput value={newEnvName} onChange={setNewEnvName} placeholder="e.g. production" />
        </div>
        <button
          type="button"
          onClick={onAddEnv}
          disabled={busy || !newEnvName.trim()}
          className="rounded-md px-2 py-1 text-[10px] uppercase tracking-wider"
          style={{ color: 'var(--text-primary)', border: '1px solid var(--border-default)' }}
        >
          Add
        </button>
        <button
          type="button"
          onClick={() => { setAdding(false); setNewEnvName('') }}
          className="rounded-md px-2 py-1 text-[10px] uppercase tracking-wider"
          style={{ color: 'var(--text-muted)' }}
        >
          Cancel
        </button>
      </div>
    )
  }
  return (
    <button
      type="button"
      onClick={() => setAdding(true)}
      className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[10px] uppercase tracking-wider"
      style={{ color: 'var(--text-muted)', border: '1px dashed var(--border-default)' }}
    >
      <PlusIcon />
      Env
    </button>
  )
}

