import { useRef, useState } from 'react'
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
}: {
  cacheKey: string
  load: () => Promise<Doc>
  extract: (doc: Doc) => Slice
  merge: (doc: Doc, slice: Slice) => unknown
  save: (payload: unknown) => Promise<Doc>
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
} {
  const cached = useCachedDoc<Doc>(cacheKey, load)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [savedAt, setSavedAt] = useState<number | null>(null)

  const currentKey = useRef(cacheKey)
  if (currentKey.current !== cacheKey) {
    currentKey.current = cacheKey
    setSaving(false)
    setSaveError(null)
    setSavedAt(null)
  }

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
  const { baseline, draft } = edit
  const changedElsewhere = dirty && doc !== null && JSON.stringify(extract(doc)) !== JSON.stringify(baseline)

  const setDraft: (next: Slice | ((prev: Slice) => Slice)) => void = (next) => {
    setEdit((prev) => ({
      ...prev,
      draft: typeof next === 'function'
        ? (next as (p: Slice) => Slice)(prev.draft as Slice)
        : next,
    }))
  }

  const doSave = async (): Promise<void> => {
    if (!doc || draft == null) return
    setSaving(true)
    setSaveError(null)
    try {
      const payload = merge(doc, draft)
      // Writing the saved document back to the cache is what keeps the other
      // tabs on the same key honest — they render from it without a refetch.
      const saved = await save(payload)
      // A response for the previous suite must not reset the new suite's editor.
      if (currentKey.current !== cacheKey) return
      const slice = extract(saved)
      setEdit((previous) => ({ key: cacheKey, from: saved, baseline: slice,
        draft: JSON.stringify(previous.draft) === JSON.stringify(draft) ? slice : previous.draft }))
      cached.setDoc(saved)
      setSavedAt(Date.now())
    } catch (e: unknown) {
      if (currentKey.current === cacheKey) setSaveError(e instanceof Error ? e.message : 'Save failed')
    } finally {
      if (currentKey.current === cacheKey) setSaving(false)
    }
  }

  const discard = (): void => {
    const latest = doc == null ? null : extract(doc)
    setEdit({ key: cacheKey, from: doc, baseline: latest, draft: latest })
    setSaveError(null)
  }

  return {
    doc,
    draft,
    setDraft,
    loading: cached.loading,
    saving,
    error: saveError ?? cached.error ?? (changedElsewhere ? 'Changed elsewhere. Your draft is preserved; Save applies your edits, Discard loads the latest values.' : null),
    savedAt,
    dirty,
    baseline,
    doSave,
    discard,
  }
}
