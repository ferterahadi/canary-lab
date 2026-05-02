import { useEffect, useState } from 'react'

/** Generic editor state hook: load → draft → diff → save.
 *
 *  - `load`: fetches the canonical document.
 *  - `extract`: maps a doc into the slice the tab actually edits.
 *  - `merge`: maps the edited slice back into a full doc payload to PUT.
 *  - `save`: PUTs and returns the refreshed doc. */
export function useEditableSlice<Doc, Slice>({
  load,
  extract,
  merge,
  save,
  deps,
}: {
  load: () => Promise<Doc>
  extract: (doc: Doc) => Slice
  merge: (doc: Doc, slice: Slice) => unknown
  save: (payload: unknown) => Promise<Doc>
  deps: ReadonlyArray<unknown>
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
  const [doc, setDoc] = useState<Doc | null>(null)
  const [baseline, setBaseline] = useState<Slice | null>(null)
  const [draft, setDraftState] = useState<Slice | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [savedAt, setSavedAt] = useState<number | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    load()
      .then((d) => {
        if (cancelled) return
        const slice = extract(d)
        setDoc(d)
        setBaseline(slice)
        setDraftState(slice)
      })
      .catch((e: unknown) => {
        if (cancelled) return
        setError(e instanceof Error ? e.message : 'Failed to load')
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)

  const setDraft: (next: Slice | ((prev: Slice) => Slice)) => void = (next) => {
    setDraftState((prev) => {
      const resolved = typeof next === 'function'
        ? (next as (p: Slice) => Slice)(prev as Slice)
        : next
      return resolved
    })
  }

  const dirty = JSON.stringify(draft) !== JSON.stringify(baseline)

  const doSave = async (): Promise<void> => {
    if (!doc || draft == null) return
    setSaving(true)
    setError(null)
    try {
      const payload = merge(doc, draft)
      const next = await save(payload)
      const slice = extract(next)
      setDoc(next)
      setBaseline(slice)
      setDraftState(slice)
      setSavedAt(Date.now())
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  const discard = (): void => {
    setDraftState(baseline)
    setError(null)
  }

  return { doc, draft, setDraft, loading, saving, error, savedAt, dirty, baseline, doSave, discard }
}
