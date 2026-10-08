import fs from 'fs'

/** A file's text, or null when it is missing or unreadable. For best-effort
 *  reads whose caller treats "no file" and "can't read it" the same way. */
export function readTextOrNull(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf-8')
  } catch {
    return null // missing and unreadable are the same answer to a best-effort read
  }
}

/** A JSON file's parsed value, or `fallback` when it is missing, unreadable or
 *  not valid JSON. The value is not validated: the caller still owns its shape. */
export function readJsonOr<T>(file: string, fallback: T): T {
  const text = readTextOrNull(file)
  if (text === null) return fallback
  try {
    return JSON.parse(text) as T
  } catch {
    return fallback // a torn or hand-edited file reads as absent
  }
}
