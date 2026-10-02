const escapes: Record<string, string> = {
  a: '\x07', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v',
  '"': '"', '\\': '\\',
}
const quotedPath = String.raw`"(?:[^"\\\x00-\x1f]|\\(?:[abfnrtv"\\]|[0-3][0-7]{2}))*"`
const quoted = new RegExp(`^${quotedPath}$`)
const operand = `(?:${quotedPath}|[^\\x00-\\x20"\\\\]+)`
const renamed = new RegExp(`^${operand} -> (${operand})$`)

/** Decode one porcelain-v1 pathname without changing the raw status wire format. */
export function porcelainPath(line: string): string {
  const payload = line.slice(3)
  let target = payload
  if (/[RC]/.test(line.slice(0, 2))) {
    const match = renamed.exec(payload)
    if (!match) return payload
    target = match[1]
  }
  if (!target.startsWith('"')) return target
  if (!quoted.test(target)) return payload

  // Git octal escapes represent bytes, not Unicode code points. Decode the
  // assembled bytes once so a multi-byte UTF-8 filename survives intact.
  const bytes: Buffer[] = []
  for (const match of target.slice(1, -1).matchAll(/\\([0-3][0-7]{2}|[abfnrtv"\\])|([^\\]+)/g)) {
    const escape = match[1]
    bytes.push(escape
      ? escape.length === 3 ? Buffer.from([parseInt(escape, 8)]) : Buffer.from(escapes[escape])
      : Buffer.from(match[2]))
  }
  return Buffer.concat(bytes).toString('utf8')
}
