import fs from 'fs'
import type { RunBootEvidence } from '../../../../../../../shared/run-state'
import { stripAnsi } from './log-enrichment'

// Diagnostic snippets are persisted on manifests and returned through REST,
// WebSocket and MCP. Redact common credential shapes before any of those
// durable or agent-visible surfaces see the text.
const ASSIGNMENT_SECRET = /\b(password|passwd|pwd|token|secret|api[_-]?key|authorization|cookie|dsn)\b(\s*[:=]\s*)([^\s,;]+)/gi
const SECRET_HEADER = /\b(authorization|cookie)\s*:\s*[^\r\n]+/gi
const FLAG_SECRET = /(--?(?:password|passwd|token|secret|api[_-]?key)\b(?:\s+|=))([^\s]+)/gi
const BEARER_SECRET = /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi
const URL_CREDENTIALS = /([a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)([^\s@]+)(@)/gi
const PRIVATE_KEY = /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g

export function redactDiagnosticText(text: string): string {
  return text
    .replace(PRIVATE_KEY, '[REDACTED PRIVATE KEY]')
    .replace(SECRET_HEADER, '$1: [REDACTED]')
    .replace(URL_CREDENTIALS, '$1[REDACTED]$3')
    .replace(BEARER_SECRET, 'Bearer [REDACTED]')
    .replace(ASSIGNMENT_SECRET, '$1$2[REDACTED]')
    .replace(FLAG_SECRET, '$1[REDACTED]')
}

export const DIAGNOSTIC_EXCERPT_MAX_BYTES = 4096

export function diagnosticExcerpt(
  logPath: string,
  maxBytes = DIAGNOSTIC_EXCERPT_MAX_BYTES,
): { excerpt?: string; truncated: boolean } {
  let raw: string
  try { raw = fs.readFileSync(logPath, 'utf-8') } catch { return { truncated: false } }
  const cleaned = stripAnsi(redactDiagnosticText(raw)).trim()
  if (!cleaned) return { truncated: false }
  const bytes = Buffer.from(cleaned)
  if (bytes.length <= maxBytes) return { excerpt: cleaned, truncated: false }
  let excerpt = bytes.subarray(bytes.length - maxBytes).toString('utf-8').replace(/^\uFFFD/, '')
  while (Buffer.byteLength(excerpt) > maxBytes) excerpt = excerpt.slice(1)
  return { excerpt, truncated: true }
}

/**
 * What the preserved log evidence adds on top of the boot `reason`. Returns
 * null when the evidence only confirms the reason, so a record carries a
 * classification exactly when it says something new.
 *
 * Only the two reasons that HAVE log evidence are accepted: a spawn failure and
 * a dependency-preflight rejection are classified by their producer from the
 * failure it already holds, so passing them here was an unreachable arm.
 */
export function classifyBootEvidence(input: {
  reason: 'health-timeout' | 'process-exited'
  excerpt?: string
  exitCode?: number | null
  signal?: string | null
}): RunBootEvidence | null {
  const excerpt = input.excerpt?.trim() ?? ''
  if (!excerpt) return 'empty-output'
  if (input.signal != null) return 'abrupt-signal'
  if (/\b(seed(?:ing)?|migration)\b[\s\S]*\b(error|failed|failure)\b|\b(error|failed|failure)\b[\s\S]*\b(seed(?:ing)?|migration)\b/i.test(excerpt)) return 'seed-failure'
  if (/\b(TS\d{4}|SyntaxError|compile(?:r|d|ation)? failed|typecheck failed|webpack.*error)\b/i.test(excerpt)) return 'compiler-failure'
  if (/\b(UnhandledPromiseRejection|startup (?:promise )?rejected|rejected startup|failed to start)\b/i.test(excerpt) && excerpt.includes('\n')) return 'rejected-startup'
  if ((input.reason === 'process-exited' && input.exitCode === 0) || !excerpt.includes('\n')) return 'underlying-cause-not-preserved'
  return null
}
