import path from 'path'
import { actionFromIdentifier, readableObject } from './audience'

/** Only rewrite words that actually look like code — dotted paths, snake_case,
 *  $-prefixed, or camelCase. Ordinary prose has to survive verbatim: splitting
 *  every capitalised run turned "stops issuing OTPs" into "stops issuing ot ps". */
export function looksLikeIdentifier(word: string): boolean {
  if (/[_$]/.test(word)) return true
  // A dotted word is only a property path when both sides are real names —
  // otherwise prose abbreviations ("e.g.", "i.e.") get split into "e g".
  if (word.includes('.')) return word.split('.').every((part) => part.length > 1)
  return /^[a-z][\w$]*[A-Z]/.test(word)
}

export const ANNOTATION_TAG = /@[A-Za-z][\w]*-[\w.-]+/g

/** Playwright titles carry the coverage annotations inline (`@req-R3 @path-sad …`).
 *  They are metadata, not prose — the report shows them as tags beside the case
 *  and keeps the headline readable. */
export function splitAnnotations(title: string): { text: string; tags: string[] } {
  const tags = dedupe(title.match(ANNOTATION_TAG) ?? [])
  return { text: title.replace(ANNOTATION_TAG, '').replace(/\s+/g, ' ').trim(), tags }
}

export function comparableTitle(title: string): string {
  return splitAnnotations(title).text.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

export function readableHelperName(name: string): string {
  return sentenceCase(actionFromIdentifier(name) || humanizeIdentifier(name))
}

export function humanizeIdentifier(value: string): string {
  const parts = value.split('.').flatMap(identifierWords)
  return readableObject(parts) || value
}

export function identifierWords(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[_$.-]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase())
}

export function displayWord(word: string): string {
  if (word === 'ids') return 'identifiers'
  if (word === 'id') return 'identifier'
  return word
}

export function sentenceCase(value: string): string {
  if (!value) return value
  return `${value[0].toUpperCase()}${value.slice(1)}`
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function escapeAttr(value: string): string {
  return escapeHtml(value).replace(/`/g, '&#96;')
}

export function statusClass(status: string): string {
  return status.toLowerCase().replace(/[^a-z0-9_-]+/g, '-') || 'unknown'
}

export function cleanSnippet(input: string): string {
  return input.replace(/\r\n/g, '\n').trim()
}

export function inline(input: string): string {
  return input.replace(/\s+/g, ' ').replace(/`/g, '\\`').slice(0, 220)
}

export function dedupe(values: string[]): string[] {
  return [...new Set(values)]
}

// HTML anchor ids must be unique within a document, so a repeat sanitises to
// `<base>-2`, `<base>-3`, … The one production caller prefixes each value with
// its 1-based index, which means it can never hit the suffix loop or the empty
// fallback — both are part of this helper's contract rather than dead code, and
// are pinned by direct tests through the internals seam.
export function uniqueSectionIds(values: string[]): string[] {
  const used = new Set<string>()
  return values.map((value) => {
    const base = safeFilename(value)
    let candidate = base
    let suffix = 2
    while (used.has(candidate)) {
      candidate = `${base}-${suffix}`
      suffix += 1
    }
    used.add(candidate)
    return candidate
  })
}

export function safeFilename(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'section'
}

export function titleCaseFeatureName(input: string): string {
  return input
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b[a-zA-Z]/g, (char) => char.toUpperCase())
}

export function slugFromTitle(title: string): string {
  return `test-case-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`
}

export function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}
