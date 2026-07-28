import { useEffect, useState } from 'react'
import * as api from '@/shared/api/client'
import { ConfirmModal, FieldRow, FolderIcon, HintIcon, IconButton, Section, TrashIcon } from '@/shared/ui/atoms'
import { AddSlotModal, inlineSelectStyle } from './AddSlotModal'
import { NewEnvControl } from './NewEnvControl'
import { SlotEditor } from './SlotEditor'
import { NEW_ENV_SENTINEL, NEW_SLOT_SENTINEL, stripFeaturePrefix } from './envset-diff'
import { useCachedDoc } from './config-doc-cache'

export function EnvsetsTab({ feature }: { feature: string }) {
  // Cached for the dialog's lifetime, so returning to this tab paints the env
  // list from memory instead of blanking to "Loading…" while it re-reads.
  const cached = useCachedDoc(`envsets:${feature}`, () => api.getEnvsetsIndex(feature))
  const index = cached.doc
  const setIndex = cached.setDoc
  const [mutationError, setMutationError] = useState<string | null>(null)
  const error = mutationError ?? cached.error
  const setError = setMutationError
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

  // Default the selection to the first env/slot once the index is known —
  // whether it arrived from the network or straight out of the cache.
  useEffect(() => {
    if (env || !index || index.envs.length === 0) return
    setEnv(index.envs[0].name)
    setSlot(index.envs[0].slots[0] ?? null)
  }, [env, index])

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
      {/* The env/slot pickers live in a Section card like every other config tab
          (General, Service, Playwright), and the intro caption sits inside the
          card it explains instead of as a full-bleed strip at the modal edge.
          `px-3 pt-3` (not the usual `p-3` scroller) because this block stays put
          while SlotEditor below owns the scrolling — its own `p-3` supplies the
          12px gap between the two cards. */}
      <div className="px-3 pt-3">
      <Section title="Env & slot">
        <p className="mb-2.5 text-[11px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
          Envsets temporarily replace environment files in the linked repos during a run. Pick an env, then edit each slot's values.
        </p>
      <div className="flex flex-col gap-1">
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
      </Section>
      </div>
      {error && (
        <div className="px-4 pt-2 text-xs" style={{ color: 'var(--danger)' }}>{error}</div>
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
