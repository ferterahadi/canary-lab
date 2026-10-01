import { useEffect, useMemo, useRef, useState } from 'react'
import { useCachedDoc } from './config-doc-cache'

/** Generic editor state hook: load → draft → diff → save.
 *
 *  - `cacheKey`: the document's identity within the open dialog. Two tabs that
 *    read the same document pass the same key and share one fetch (see
 *    `config-doc-cache`). Key changes switch documents; workspace events and
 *    recovery reads keep the mounted document current.
 *  - `load`: fetches the canonical document.
 *  - `extract`: maps a doc into the slice the tab actually edits.
 *  - `merge`: maps the edited slice back into a full doc payload to PUT.
 *  - `save`: PUTs and returns the refreshed doc. */
export function useEditableSlice<Doc, Slice>({
  cacheKey,
  load,
  extract,
  merge,
  save,
  immediate = false,
}: {
  cacheKey: string
  load: () => Promise<Doc>
  extract: (doc: Doc) => Slice
  merge: (doc: Doc, slice: Slice) => unknown
  save: (payload: unknown) => Promise<Doc>
  /** Flight commits field edits immediately; Advanced setup keeps Save/Discard. */
  immediate?: boolean
}): {
  doc: Doc | null
  draft: Slice | null
  setDraft: (next: Slice | ((prev: Slice) => Slice)) => void
  loading: boolean
  saving: boolean
  error: string | null
  savedAt: number | null
  dirty: boolean
  baseline: Slice | null
  doSave: () => Promise<void>
  discard: () => void
  refresh: () => void
  editImmediate: (update: (slice: Slice) => Slice) => void
} {
  const cached = useCachedDoc<Doc>(cacheKey, load)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [savedAt, setSavedAt] = useState<number | null>(null)

  const lifetime = useMemo(() => ({ key: cacheKey, active: false, writing: false, failed: false, pending: [] as Array<(slice: Slice) => Slice> }), [cacheKey])
  const rendered = useRef(lifetime)
  rendered.current = lifetime
  const latest = useRef({ doc: cached.doc, merge, extract, save, setDoc: cached.setDoc })
  latest.current = { doc: cached.doc, merge, extract, save, setDoc: cached.setDoc }
  const [, changed] = useState(0)
  useEffect(() => {
    lifetime.active = true
    setSaving(false)
    setSaveError(null)
    setSavedAt(null)
    return () => { lifetime.active = false; lifetime.pending = [] }
  }, [lifetime])
  const current = () => lifetime.active && rendered.current === lifetime

  // Baseline + draft are derived from whichever document the cache is holding.
  // Deriving during render rather than in an effect is what makes a cached
  // document paint filled-in on its first frame instead of flashing "Loading…"
  // for one commit — `edit.from` is the document identity the pair was cut from.
  const doc = cached.doc
  const [edit, setEdit] = useState<{ key: string; from: Doc | null; baseline: Slice | null; draft: Slice | null }>(
    { key: cacheKey, from: null, baseline: null, draft: null },
  )
  const dirty = JSON.stringify(edit.draft) !== JSON.stringify(edit.baseline)
  if (edit.key !== cacheKey || edit.from !== doc) {
    const slice = doc == null ? null : extract(doc)
    const retain = edit.key === cacheKey && dirty
    setEdit({ key: cacheKey, from: doc, baseline: retain ? edit.baseline : slice, draft: retain ? edit.draft : slice })
  }
  const baseline = immediate && doc !== null ? extract(doc) : edit.baseline
  const draft = immediate && baseline !== null ? lifetime.pending.reduce<Slice>((value, update) => update(value), baseline) : edit.draft
  const changedElsewhere = dirty && doc !== null && JSON.stringify(extract(doc)) !== JSON.stringify(baseline)

  const setDraft: (next: Slice | ((prev: Slice) => Slice)) => void = (next) => {
    setEdit((prev) => ({
      ...prev,
      draft: typeof next === 'function'
        ? (next as (p: Slice) => Slice)(prev.draft as Slice)
        : next,
    }))
  }

  // Both editing modes publish only server-confirmed documents. Pending edits
  // stay outside the cache so reconciliation cannot certify an unsaved value.
  const persist = async (payload: unknown, accepted: (saved: Doc) => void): Promise<boolean> => {
    setSaving(true)
    setSaveError(null)
    try {
      const saved = await latest.current.save(payload)
      if (!current()) return false
      accepted(saved)
      latest.current.doc = saved
      cached.setDoc(saved)
      setSavedAt(Date.now())
      return true
    } catch (error: unknown) {
      if (current()) setSaveError(error instanceof Error ? error.message : 'Save failed')
      return false
    } finally { if (current()) setSaving(false) }
  }
  const pump = async (retry = false): Promise<void> => {
    if (!current() || lifetime.writing || (lifetime.failed && !retry)) return
    if (retry) lifetime.failed = false
    lifetime.writing = true
    try {
      while (current() && lifetime.pending.length && latest.current.doc !== null) {
        const base = latest.current.doc
        const count = lifetime.pending.length
        const next = lifetime.pending.reduce<Slice>((value, update) => update(value), latest.current.extract(base))
        const ok = await persist(latest.current.merge(base, next), () => { lifetime.pending.splice(0, count) })
        if (!ok) { lifetime.failed = true; break }
      }
    } finally { lifetime.writing = false; if (current()) changed((value) => value + 1) }
  }
  const editImmediate = (update: (slice: Slice) => Slice): void => {
    if (!current()) return
    lifetime.pending.push(update)
    changed((value) => value + 1)
    void pump()
  }
  const doSave = async (): Promise<void> => {
    if (immediate) return pump(true)
    if (!current() || !doc || draft == null) return
    await persist(merge(doc, draft), (saved) => {
      const slice = extract(saved)
      setEdit((previous) => ({ key: cacheKey, from: saved, baseline: slice,
        draft: JSON.stringify(previous.draft) === JSON.stringify(draft) ? slice : previous.draft }))
    })
  }

  const discard = (): void => {
    const latest = doc == null ? null : extract(doc)
    setEdit({ key: cacheKey, from: doc, baseline: latest, draft: latest })
    lifetime.pending = []
    lifetime.failed = false
    setSaveError(null)
  }

  return {
    doc,
    draft,
    setDraft,
    loading: cached.loading,
    saving,
    error: saveError ?? cached.error ?? (!immediate && changedElsewhere ? 'Changed elsewhere. Your draft is preserved; Save applies your edits, Discard loads the latest values.' : null),
    savedAt,
    dirty: immediate ? lifetime.pending.length > 0 : dirty,
    baseline,
    doSave,
    discard,
    editImmediate,
    refresh: cached.refresh,
  }
}
