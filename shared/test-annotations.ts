export interface TestAnnotationToken { raw: string; kind: string; value: string }

/** Token boundaries match the recorded report syntax. Consumers choose which
 * kinds to lift out of prose and whether repeated tags should be displayed. */
export function tokenizeTestAnnotations(title: string, kinds?: readonly string[]): { title: string; tokens: TestAnnotationToken[] } {
  const tokens: TestAnnotationToken[] = []
  const text = title.replace(/@([A-Za-z][\w]*)-([\w.-]+)/g, (raw, kind: string, value: string) => {
    if (kinds && !kinds.includes(kind)) return raw
    tokens.push({ raw, kind, value })
    return ''
  }).replace(/\s+/g, ' ').trim()
  return { title: text, tokens }
}
