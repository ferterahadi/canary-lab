import type { KeyboardEvent } from 'react'

/** Keydown handler that gives a non-`<button>` `role="button"` element the
 *  native button's keys: Enter or Space activates it, and `preventDefault`
 *  keeps Space from scrolling the page. `ownTargetOnly` ignores keys bubbling
 *  up from a focusable child, which handles its own; `stopPropagation` keeps an
 *  enclosing clickable row from reacting too. */
export function activateOnKey<T extends Element>(
  activate: (e: KeyboardEvent<T>) => void,
  { ownTargetOnly = false, stopPropagation = false }: { ownTargetOnly?: boolean; stopPropagation?: boolean } = {},
): (e: KeyboardEvent<T>) => void {
  return (e) => {
    if (ownTargetOnly && e.target !== e.currentTarget) return
    if (e.key !== 'Enter' && e.key !== ' ') return
    e.preventDefault()
    if (stopPropagation) e.stopPropagation()
    activate(e)
  }
}

/** Keydown handler for a text input that commits on Enter by blurring it, so
 *  the field's `onBlur` save runs exactly as if the user had tabbed away. */
export function blurOnEnter(e: KeyboardEvent<HTMLInputElement>): void {
  if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
}
