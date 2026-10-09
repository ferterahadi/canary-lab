import { useCallback, useState } from 'react'
import { readGroupOpen, writeGroupOpen } from './group-open-state'

export function usePersistedGroupOpen({
  storageKey,
  group,
  defaultOpen,
  expandInitially = false,
}: {
  storageKey: string
  group: string
  defaultOpen: boolean
  expandInitially?: boolean
}): { open: boolean; toggle: () => void } {
  const [open, setOpen] = useState(() => expandInitially || readGroupOpen(storageKey, group, defaultOpen))
  const toggle = useCallback(() => setOpen((value) => {
    const next = !value
    writeGroupOpen(storageKey, group, next)
    return next
  }), [storageKey, group])
  return { open, toggle }
}
