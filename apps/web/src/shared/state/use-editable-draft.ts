import { useRef, useState } from 'react'

const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
export const CHANGED_ELSEWHERE = 'Changed elsewhere. Your draft is preserved; Save applies your edits, Discard loads the latest values.'

/** Drafts are local edits over an owned remote document, never another reader.
 * Field mode rebases untouched fields; existing slice editors retain their whole draft. */
export function useEditableDraft<Doc, Slice>({ key, doc, extract, fields = false, initialize = (value) => value }: {
  key: string
  doc: Doc | null
  extract: (doc: Doc) => Slice
  fields?: boolean
  initialize?: (value: Slice) => Slice
}) {
  const revisions = useRef(new Map<keyof Slice, number>())
  const submittedRevisions = new Map(revisions.current)
  type Edit = { key: string; from: Doc | null; baseline: Slice | null; draft: Slice | null }
  const [state, setState] = useState<Edit>({ key, from: null, baseline: null, draft: null })
  let edit = state
  if (edit.key !== key || edit.from !== doc) {
    if (edit.key !== key) revisions.current.clear()
    const slice = doc === null ? null : extract(doc)
    const retain = edit.key === key && !equal(edit.draft, edit.baseline)
    if (fields && retain && slice != null && edit.draft != null && edit.baseline != null) {
      const baseline = { ...slice }
      const draft = { ...slice }
      for (const field of Object.keys(edit.draft) as Array<keyof Slice>) {
        if (!equal(edit.draft[field], edit.baseline[field]) && !equal(edit.draft[field], slice[field])) {
          baseline[field] = edit.baseline[field]
          draft[field] = edit.draft[field]
        }
      }
      edit = { key, from: doc, baseline, draft }
    } else edit = { key, from: doc, baseline: retain ? edit.baseline : slice, draft: retain ? edit.draft : slice === null ? null : initialize(slice) }
    setState(edit)
  }
  const latest = useRef(edit)
  latest.current = edit
  const replace = (next: Edit) => { latest.current = next; setState(next) }
  const setDraft = (next: Slice | ((previous: Slice) => Slice)) => {
    const previous = latest.current
    if (previous.key !== key) return
    const draft = typeof next === 'function' ? (next as (value: Slice) => Slice)(previous.draft as Slice) : next
    if (fields && draft != null) for (const field of Object.keys(draft) as Array<keyof Slice>) {
      if (!equal(draft[field], previous.draft?.[field])) revisions.current.set(field, (revisions.current.get(field) ?? 0) + 1)
    }
    replace({ ...previous, draft })
  }
  const acceptSaved = (saved: Doc, submitted: Slice): boolean => {
    const slice = extract(saved)
    const previous = latest.current
    if (previous.key !== key) return false
    let draft = equal(previous.draft, submitted) ? slice : previous.draft
    if (fields && previous.draft != null && slice != null) {
      const rebased = { ...slice }
      for (const field of Object.keys(previous.draft) as Array<keyof Slice>) {
        if (revisions.current.get(field) !== submittedRevisions.get(field)) rebased[field] = previous.draft[field]
      }
      draft = rebased
    }
    replace({ key, from: saved, baseline: slice, draft })
    return equal(draft, slice)
  }
  const discard = () => {
    const slice = doc === null ? null : extract(doc)
    replace({ key, from: doc, baseline: slice, draft: slice })
  }
  const patch: Partial<Slice> = {}
  if (fields && edit.draft != null && edit.baseline != null) {
    for (const field of Object.keys(edit.draft) as Array<keyof Slice>) {
      if (!equal(edit.draft[field], edit.baseline[field])) patch[field] = edit.draft[field]
    }
  }
  const dirty = !equal(edit.draft, edit.baseline)
  const changedElsewhere = dirty && doc !== null && !equal(extract(doc), edit.baseline)
  return { baseline: edit.baseline, draft: edit.draft, dirty, changedElsewhere, patch, setDraft, acceptSaved, discard }
}
