/**
 * Block-preserving editor for KEY=VALUE files (.env, .properties, .env.local).
 * Comments, blank lines, and key ordering are preserved across edits — only
 * touched keys get rewritten in place. Lines we can't parse (multi-line
 * values, complex escapes) are surfaced as `unparsedLines` so the UI can
 * warn rather than silently mangle them.
 */

export interface KvEntry {
  key: string
  value: string
}

export interface ParsedDotenv {
  entries: KvEntry[]
  unparsedLines: number[]
}

const KV_LINE = /^\s*([A-Za-z_][\w.-]*)\s*=\s*(.*?)\s*$/

function stripQuotes(v: string): string {
  if (v.length >= 2 && (v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1)
  }
  return v
}

export function parseDotenv(source: string): ParsedDotenv {
  const lines = source.split(/\r?\n/)
  const entries: KvEntry[] = []
  const unparsed: number[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim().length === 0) continue
    if (line.trim().startsWith('#')) continue
    const m = line.match(KV_LINE)
    if (!m) {
      unparsed.push(i + 1)
      continue
    }
    entries.push({ key: m[1], value: stripQuotes(m[2]) })
  }
  return { entries, unparsedLines: unparsed }
}

/** Block-aware writer: rebuild lines while preserving original raw text for
 *  comments/blank lines and unparsed lines. */
export function writeDotenv(source: string, next: KvEntry[]): string {
  const lines = source.split(/\r?\n/)
  const trailingNewline = source.endsWith('\n')
  const nextMap = new Map<string, string>(next.map((e) => [e.key, e.value]))
  const seen = new Set<string>()
  const out: string[] = []

  for (const line of lines) {
    if (line.trim().length === 0 || line.trim().startsWith('#')) {
      out.push(line)
      continue
    }
    const m = line.match(KV_LINE)
    if (!m) {
      // Preserve unparseable lines verbatim.
      out.push(line)
      continue
    }
    const key = m[1]
    if (!nextMap.has(key)) {
      // Removed by the patch — drop the line.
      continue
    }
    seen.add(key)
    const newValue = nextMap.get(key)!
    const oldValue = stripQuotes(m[2])
    if (newValue === oldValue) {
      out.push(line)
    } else {
      out.push(`${key}=${formatValue(newValue)}`)
    }
  }

  // Append newly-added keys at the end (preserve patch order).
  const tail: string[] = []
  for (const e of next) {
    if (seen.has(e.key)) continue
    tail.push(`${e.key}=${formatValue(e.value)}`)
  }
  if (tail.length > 0) {
    if (out.length > 0 && out[out.length - 1].trim() !== '') out.push('')
    out.push(...tail)
  }

  let body = out.join('\n')
  if (trailingNewline && !body.endsWith('\n')) body += '\n'
  return body
}

function formatValue(v: string): string {
  // Quote when the value contains whitespace or characters that would
  // confuse downstream loaders. Keep it simple — the common case is bare.
  if (v === '' || /^[A-Za-z0-9_./:@\-+]+$/.test(v)) return v
  // Escape inner double quotes.
  return `"${v.replace(/"/g, '\\"')}"`
}
