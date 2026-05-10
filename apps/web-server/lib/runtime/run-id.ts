// Generates run IDs of the form `<ISO-minute>-<4-char-suffix>`, e.g.
// `2026-04-28T1015-abc1`. Filesystem-safe, naturally sortable, and unique per
// run within the same minute thanks to the random suffix.

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'

export interface GenerateRunIdOptions {
  // Injected for tests; defaults to current wall-clock time.
  now?: () => Date
  // Injected for tests; defaults to Math.random.
  random?: () => number
}

export function formatTimestamp(d: Date): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, '0')
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`
  )
}

export function randomSuffix(random: () => number = Math.random, length = 4): string {
  let out = ''
  for (let i = 0; i < length; i++) {
    const idx = Math.floor(random() * ALPHABET.length) % ALPHABET.length
    out += ALPHABET[idx]
  }
  return out
}

export function generateRunId(opts: GenerateRunIdOptions = {}): string {
  const now = opts.now ?? (() => new Date())
  const random = opts.random ?? Math.random
  return `${formatTimestamp(now())}-${randomSuffix(random)}`
}

export const RUN_ID_RE = /^\d{4}-\d{2}-\d{2}T\d{4}-[a-z0-9]{4}$/

export function isValidRunId(s: string): boolean {
  return RUN_ID_RE.test(s)
}
