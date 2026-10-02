// These names join reporter results, service-log markers and browser/export
// evidence. Keep this module browser-safe so every consumer uses the same key.
export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

export function summaryEntryName(title: string): string {
  return `test-case-${slugify(title)}`
}
