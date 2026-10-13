import fs from 'fs'
import path from 'path'

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

/** Append one JSON value as a line, creating the parent directory on first
 *  use. The writer half of `readJsonLines`: one `appendFileSync` per entry, so
 *  a crash mid-write tears at most the last line, which the reader skips. */
export function appendJsonLine(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.appendFileSync(file, JSON.stringify(value) + '\n')
}
