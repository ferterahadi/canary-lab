// Word marks inside an already-highlighted line. Shiki tokenizes the whole
// file, so a changed word can start or end mid-token: the line's HTML is cut
// at each part boundary, and every cut closes the open token spans and reopens
// them in the next segment so each segment stays balanced markup.
import type { TextPart } from '../lib/comparison-diff'

export interface MarkedSegment { html: string; changed: boolean }

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' }

/** The character an entity at `at` stands for, or `null` for one this
 * reader does not know. */
function readEntity(html: string, at: number): { text: string; end: number } | null {
  const end = html.indexOf(';', at)
  if (end < 0) return null
  const name = html.slice(at + 1, end)
  const hex = /^#x([0-9a-f]+)$/i.exec(name)?.[1]
  const decimal = /^#(\d+)$/.exec(name)?.[1]
  const text = hex ? String.fromCodePoint(parseInt(hex, 16)) : decimal ? String.fromCodePoint(Number(decimal)) : NAMED[name]
  return text === undefined ? null : { text, end: end + 1 }
}

/** Split a highlighted line into marked and unmarked segments. When the
 * markup's text is not exactly the parts' text — a highlighter that rewrote a
 * character, or markup this reader cannot follow — the line comes back as one
 * unmarked segment: an unmarked word is honest, a misplaced mark is not. */
export function markHighlightedLine(html: string, parts: readonly TextPart[]): MarkedSegment[] {
  const whole = [{ html, changed: false }]
  const segments: MarkedSegment[] = []
  const open: Array<{ tag: string; name: string }> = []
  let part = 0
  let used = 0
  let current = ''
  const begin = (): void => { current = open.map((item) => item.tag).join('') }
  const end = (): void => {
    segments.push({ html: current + [...open].reverse().map((item) => `</${item.name}>`).join(''), changed: parts[part].changed })
    part++
    used = 0
    begin()
  }
  // Empty parts carry no characters; they would only produce empty segments.
  const skipEmpty = (): void => { while (part < parts.length && parts[part].text === '') part++ }
  skipEmpty()
  begin()
  for (let at = 0; at < html.length;) {
    if (html[at] === '<') {
      const close = html.indexOf('>', at)
      if (close < 0) return whole
      const tag = html.slice(at, close + 1)
      if (tag.startsWith('</')) open.pop()
      else if (!tag.endsWith('/>')) open.push({ tag, name: tag.slice(1).split(/[\s>]/)[0] })
      current += tag
      at = close + 1
      continue
    }
    const entity = html[at] === '&' ? readEntity(html, at) : { text: html[at], end: at + 1 }
    if (entity === null || part >= parts.length) return whole
    current += html.slice(at, entity.end)
    used += entity.text.length
    at = entity.end
    if (used >= parts[part].text.length) {
      if (used > parts[part].text.length) return whole
      end()
      skipEmpty()
    }
  }
  return part < parts.length || !segments.length ? whole : segments
}
