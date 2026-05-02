import { useEffect, useState } from 'react'
import * as api from '../../api/client'
import { FieldRow, IconButton, PlusIcon, SectionHeader, Select, TextInput, TrashIcon } from './atoms'
import { SaveBar } from './SaveBar'

interface KvEntry { key: string; value: string }

export function EnvsetsTab({ feature }: { feature: string }) {
  const [index, setIndex] = useState<api.EnvsetIndex | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [env, setEnv] = useState<string | null>(null)
  const [slot, setSlot] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [newEnvName, setNewEnvName] = useState('')
  const [busy, setBusy] = useState(false)

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
    if (!confirm(`Delete env "${name}"? This removes the folder and all its slot files.`)) return
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
    }
  }

  if (error && !index) {
    return <div className="p-4 text-xs" style={{ color: 'var(--text-muted)' }}>{error}</div>
  }
  if (!index) {
    return <div className="p-4 text-xs" style={{ color: 'var(--text-muted)' }}>Loading…</div>
  }

  const envObj = index.envs.find((e) => e.name === env) ?? index.envs[0]
  const slotName = envObj && slot && envObj.slots.includes(slot) ? slot : envObj?.slots[0]

  return (
    <div className="flex h-full flex-col">
      <div
        className="flex flex-wrap items-center gap-3 px-4 py-2.5"
        style={{ borderBottom: '1px solid var(--border-default)' }}
      >
        {index.envs.length > 0 && envObj ? (
          <>
            <FieldRow label="Env" layout="inline">
              <div className="flex items-center gap-1.5">
                <Select
                  value={envObj.name}
                  onChange={(v) => {
                    setEnv(v)
                    const next = index.envs.find((e) => e.name === v)
                    setSlot(next?.slots[0] ?? null)
                  }}
                  options={index.envs.map((e) => ({ value: e.name, label: e.name }))}
                />
                <IconButton
                  ariaLabel="Delete env"
                  variant="danger"
                  onClick={() => { if (!busy) onDeleteEnv(envObj.name) }}
                >
                  <TrashIcon />
                </IconButton>
              </div>
            </FieldRow>
            {slotName ? (
              <FieldRow label="Slot" layout="inline" hint={index.slotDescriptions[slotName]}>
                <Select
                  value={slotName}
                  onChange={(v) => setSlot(v)}
                  options={envObj.slots.map((s) => ({ value: s, label: s }))}
                />
              </FieldRow>
            ) : null}
          </>
        ) : (
          <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
            No envs yet. Add one to get started.
          </div>
        )}
        <div className="ml-auto">
          {adding ? (
            <div className="flex items-center gap-1.5">
              <TextInput
                value={newEnvName}
                onChange={setNewEnvName}
                placeholder="e.g. production"
              />
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
          ) : (
            <button
              type="button"
              onClick={() => setAdding(true)}
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[10px] uppercase tracking-wider"
              style={{ color: 'var(--text-muted)', border: '1px dashed var(--border-default)' }}
            >
              <PlusIcon />
              New env
            </button>
          )}
        </div>
      </div>
      {error && (
        <div className="px-4 py-1.5 text-xs" style={{ color: '#ef4444' }}>{error}</div>
      )}
      {envObj && slotName ? (
        <SlotEditor key={`${envObj.name}/${slotName}`} feature={feature} env={envObj.name} slot={slotName} />
      ) : envObj ? (
        <div className="p-4 text-xs" style={{ color: 'var(--text-muted)' }}>No slots in this env.</div>
      ) : null}
    </div>
  )
}

function SlotEditor({
  feature,
  env,
  slot,
}: {
  feature: string
  env: string
  slot: string
}) {
  const [doc, setDoc] = useState<api.EnvsetSlotDoc | null>(null)
  const [draft, setDraft] = useState<KvEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<number | null>(null)

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
            <div key={i} className="flex items-center gap-1.5">
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
              <div className="flex-1">
                <TextInput
                  value={entry.value}
                  onChange={(value) => setDraft(draft.map((x, j) => j === i ? { ...x, value } : x))}
                />
              </div>
              <IconButton
                ariaLabel="Remove key"
                variant="danger"
                onClick={() => setDraft(draft.filter((_, j) => j !== i))}
              >
                <TrashIcon />
              </IconButton>
            </div>
          ))}
          <button
            type="button"
            onClick={() => setDraft([...draft, { key: '', value: '' }])}
            className="self-start mt-1 inline-flex items-center gap-1 rounded-md px-2 py-1 text-[10px] uppercase tracking-wider"
            style={{ color: 'var(--text-muted)', border: '1px dashed var(--border-default)' }}
          >
            <PlusIcon />
            Add entry
          </button>
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
    </div>
  )
}
