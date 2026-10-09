import type { JournalSection } from './run-detail'

/** Both the route and live browser reader must keep legacy entries without an
 * iteration behind numbered entries, preserving order within ties. */
export function newestFirst(entries: readonly JournalSection[]): JournalSection[] {
  return [...entries].sort((a, b) => {
    const ai = a.iteration ?? -Infinity
    const bi = b.iteration ?? -Infinity
    if (ai === bi) return 0
    return bi > ai ? 1 : -1
  })
}
