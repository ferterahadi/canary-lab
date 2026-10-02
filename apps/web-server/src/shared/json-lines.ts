import fs from 'fs'

export function readJsonLines<T>(file: string, accepts: (value: unknown) => value is T): T[] | undefined {
  let raw: string
  try {
    raw = fs.readFileSync(file, 'utf-8')
  } catch {
    // Missing or unreadable event files have no evidence to contribute.
    return undefined
  }
  const out: T[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      // An interrupted append must not hide the preceding complete events.
      continue
    }
    if (accepts(parsed)) out.push(parsed)
  }
  return out
}
