// Service output for one test attempt, read from the log that kept that
// execution: the per-execution segment, or the live log while the execution is
// the latest. Answers with bounded plain-text windows so a large log is never
// shipped to the browser whole.
import fs from 'fs'
import { buildRunEvidence } from '../../../../../../shared/run-evidence'
import type { RunManifest } from '../../../../../../shared/run-manifest'
import type { ServiceLogExcerpt, ServiceLogLines, ServiceLogSource, ServiceLogSpan } from '../../../../../../shared/run-detail'
import { buildRunPaths } from './runtime/run-paths'
import { stripAnsi } from './runtime/log-enrichment'
import { readRunLifecycleEvents } from './run-detail'

/** What the repair story's excerpt shows: the end of the span, where a
 *  failure's output usually sits. */
export const EXCERPT_MAX_LINES = 200
/** The most one full-log window request may return. */
export const WINDOW_MAX_LINES = 1000

/** One display line per physical line, so a line number means the same line
 *  in every view: control codes stripped, a carriage-return redraw resolved to
 *  its last non-empty frame. Unlike the readable-log export, repeats are kept. */
export function plainLogLines(raw: string): string[] {
  const lines = stripAnsi(raw).split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines.map((physical) => physical.split('\r').map((frame) => frame.trimEnd()).reverse().find((frame) => frame.trim()) ?? '')
}

/** Every `<name>`…`</name>` span, in file order. The fixture appends each tag
 *  with its own newline, so an open tag always ends its line and the span
 *  starts on the next. Service output without a newline can precede a tag on
 *  the same line: before a close tag, that line is the span's last. */
export function markerSpans(lines: readonly string[], name: string): ServiceLogSpan[] {
  const open = `<${name}>`
  const close = `</${name}>`
  const spans: ServiceLogSpan[] = []
  let start: number | undefined
  lines.forEach((line, index) => {
    if (start === undefined && line.includes(open)) {
      start = index + 2
    } else if (start !== undefined && line.includes(close)) {
      spans.push({ startLine: start, endLine: line.startsWith(close) ? index : index + 1, closed: true })
      start = undefined
    }
  })
  if (start !== undefined) spans.push({ startLine: start, endLine: lines.length, closed: false })
  return spans
}

/** The latest Playwright execution the run has issued: the manifest's count,
 *  or — for a run recorded before executions were numbered — the executions
 *  its lifecycle records bracket. */
export function latestExecution(runDir: string, manifest: Pick<RunManifest, 'playwrightExecutions'>): number {
  const derived = buildRunEvidence({ lifecycle: readRunLifecycleEvents(runDir) }).executions.at(-1)?.index ?? 0
  return Math.max(manifest.playwrightExecutions ?? 0, derived)
}

/** The file holding `execution`'s output for one service, or undefined when
 *  it was not retained (a run recorded before segments emptied it on rerun). */
export function serviceLogFile(
  runDir: string, service: { safeName: string; logPath: string }, execution: number, latest: number,
): { source: ServiceLogSource; file: string } | undefined {
  const segment = buildRunPaths(runDir).serviceLogSegment(service.safeName, execution)
  if (fs.existsSync(segment)) return { source: 'segment', file: segment }
  if (execution === latest && fs.existsSync(service.logPath)) return { source: 'live', file: service.logPath }
  return undefined
}

function readLines(file: string): string[] {
  return plainLogLines(fs.readFileSync(file, 'utf-8'))
}

/** Each service's span for the `occurrence`-th (0-based) of the `of` attempts
 *  named `name` in `execution`. A file ends with the execution it is named for
 *  — a segment with the last execution that wrote into it, the live log with
 *  the latest — so those attempts' spans are its last `of`. Counting from the
 *  end also reads a run recorded before every restart rotated every log, where
 *  a kept service's file holds earlier executions' spans first. */
export function serviceLogExcerpts(
  runDir: string, manifest: Pick<RunManifest, 'services' | 'playwrightExecutions'>, execution: number, name: string,
  { occurrence, of }: { occurrence: number; of: number },
): ServiceLogExcerpt[] {
  const latest = latestExecution(runDir, manifest)
  return manifest.services.map((service): ServiceLogExcerpt => {
    const base = { service: service.safeName, name: service.name, execution }
    const found = serviceLogFile(runDir, service, execution, latest)
    if (!found) return { ...base, missing: 'not-retained' }
    const lines = readLines(found.file)
    const spans = markerSpans(lines, name)
    const span = spans[spans.length - of + occurrence]
    const known = { ...base, source: found.source, totalLines: lines.length }
    if (!span) return { ...known, missing: 'no-marker' }
    const first = Math.max(span.startLine, span.endLine - EXCERPT_MAX_LINES + 1)
    return {
      ...known,
      span,
      matchedBy: spans.length === 1 && of === 1 ? 'marker' : 'order',
      window: { firstLine: first, lines: lines.slice(first - 1, span.endLine), truncated: first > span.startLine },
    }
  })
}

/** Lines `from`…`from + count - 1` of one service's log for `execution`. */
export function serviceLogLines(
  runDir: string, manifest: Pick<RunManifest, 'playwrightExecutions'>, service: { safeName: string; logPath: string },
  execution: number, from: number, count: number,
): ServiceLogLines | undefined {
  const found = serviceLogFile(runDir, service, execution, latestExecution(runDir, manifest))
  if (!found) return undefined
  const lines = readLines(found.file)
  const firstLine = Math.max(1, Math.min(from, lines.length))
  const take = Math.min(count, WINDOW_MAX_LINES)
  return {
    service: service.safeName, execution, source: found.source, totalLines: lines.length, firstLine,
    lines: lines.slice(firstLine - 1, firstLine - 1 + take),
    truncated: firstLine - 1 + take < lines.length,
  }
}
