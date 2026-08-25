import { useState } from 'react'
import { useCachedDoc } from './config-doc-cache'

/** Generic editor state hook: load → draft → diff → save.
 *
 *  - `cacheKey`: the document's identity within the open dialog. Two tabs that
 *    read the same document pass the same key and share one fetch (see
 *    `config-doc-cache`); it also replaces the old `deps` array — a key change
 *    is what re-reads the document.
 *  - `load`: fetches the canonical document (only on a cache miss).
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

  // Baseline + draft are derived from whichever document the cache is holding.
  // Deriving during render rather than in an effect is what makes a cached
  // document paint filled-in on its first frame instead of flashing "Loading…"
  // for one commit — `edit.from` is the document identity the pair was cut from.
  const doc = cached.doc
  const [edit, setEdit] = useState<{ from: Doc | null; baseline: Slice | null; draft: Slice | null }>(
    { from: null, baseline: null, draft: null },
  )
  if (edit.from !== doc) {
    const slice = doc == null ? null : extract(doc)
    setEdit({ from: doc, baseline: slice, draft: slice })
  }
  const { baseline, draft } = edit.from === doc ? edit : { baseline: null, draft: null }

  const setDraft: (next: Slice | ((prev: Slice) => Slice)) => void = (next) => {
    setEdit((prev) => ({
      ...prev,
      draft: typeof next === 'function'
        ? (next as (p: Slice) => Slice)(prev.draft as Slice)
        : next,
    }))
  }

  const dirty = JSON.stringify(draft) !== JSON.stringify(baseline)

  const doSave = async (): Promise<void> => {
    if (!doc || draft == null) return
    setSaving(true)
    setSaveError(null)
    try {
      const payload = merge(doc, draft)
      // Writing the saved document back to the cache is what keeps the other
      // tabs on the same key honest — they render from it without a refetch.
      cached.setDoc(await save(payload))
      setSavedAt(Date.now())
    } catch (e: unknown) {
      setSaveError(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  const discard = (): void => {
    setEdit((prev) => ({ ...prev, draft: prev.baseline }))
    setSaveError(null)
  }

  return {
    doc,
    draft,
    setDraft,
    loading: cached.loading,
    saving,
    error: saveError ?? cached.error,
    savedAt,
    dirty,
    baseline,
    doSave,
    discard,
  }
}
