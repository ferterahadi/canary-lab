import { useState } from 'react'
import * as api from '../../../shared/api/client'
import type { RunSummary, RunSummaryFailedEntry } from '../../../shared/api/types'

// The failing tests, rendered as evidence instead of a list of truncated slugs.
//
// Before this, the run hero showed five 11.5px rows of `test-case-req-r4-path-
// sad-a-request-with-no-bot-challenge-token-is-refused-before-a…` — the
// SLUGIFIED name, ellipsised exactly where the discriminating words live, with
// the failure reason (which the summary has carried all along, in
// `failed[].error.message` + `.snippet`) thrown away entirely. Two failures
// looked identical and neither said why it failed.
//
// Each failure is now one expandable row: the human title on its own line
// (recovered from `knownTests`, or de-slugified), its `@req-`/`@path-` tags as
// the same mono chips the coverage ledger uses, and the location · duration ·
// retry underneath. Expanding shows the assertion error and code snippet, plus
// Open-in-editor at the failing line. The first failure opens by default —
// worst-first, never blank.

/** The `@req-` / `@path-` / `@variant-` tags Canary's authoring convention puts
 *  in a test title (see `prompts/specs-coverage.md`). Rendered with the literal
 *  `@req-R4` text the coverage ledger uses, so one vocabulary spans both. */
interface TestTag {
  kind: 'req' | 'path' | 'variant'
  value: string
}

interface ParsedFailure {
  entry: RunSummaryFailedEntry
  /** The human title, tags lifted off. */
  title: string
  tags: TestTag[]
  /** Readable tail of the location (`e2e/foo.spec.ts:199`). */
  shortLoc: string
  /** Absolute path + line, for the tooltip and Open-in-editor. */
  fullLoc?: string
}

const PATH_DESC: Record<string, string> = { happy: 'happy', sad: 'unhappy (sad)', edge: 'edge-case' }

export function FailingTests({
  failing,
  knownTests,
  testId = 'run-hero-failing',
}: {
  failing: RunSummaryFailedEntry[]
  /** The run's known tests — carries each test's REAL title, which the failed
   *  entry only has in slug form. Matched by id, then by name. */
  knownTests?: RunSummary['knownTests']
  testId?: string
}) {
  if (failing.length === 0) return null
  const parsed = failing.map((entry) => parseFailure(entry, knownTests))
  return (
    // A section of the run hero, not its own card — the run stays ONE object
    // (R80). Same rubric + dashed-rule header the hero's Repairs band uses.
    <section className="mt-3 min-w-0" data-testid={testId}>
      <div className="mb-1 flex items-center gap-2">
        <span className="cl-rubric">Failing tests</span>
        <span className="h-px flex-1 border-t border-dashed border-line" />
        <span className="cl-count-chip">{failing.length}</span>
      </div>
      <ul className="m-0 flex list-none flex-col p-0">
        {parsed.map((f, i) => (
          <FailureRow key={`${f.entry.id ?? f.entry.name}-${i}`} failure={f} defaultOpen={i === 0} />
        ))}
      </ul>
    </section>
  )
}

/** One failure: a click target carrying identity, then the evidence beneath it.
 *  The title WRAPS (up to two lines) rather than truncating — the words that
 *  distinguish two failures of the same requirement sit at the end of the
 *  sentence, which is exactly what an ellipsis was eating. */
function FailureRow({ failure, defaultOpen }: { failure: ParsedFailure; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  const { entry, title, tags, shortLoc, fullLoc } = failure
  const message = entry.error?.message?.trim()
  const snippet = entry.error?.snippet?.trim()
  const detailId = `failure-${entry.id ?? entry.name}`
  return (
    <li className="border-t border-line-subtle first:border-t-0" data-testid={`failing-test-${entry.name}`}>
      <button
        type="button"
        data-testid={`failing-toggle-${entry.name}`}
        aria-expanded={open}
        aria-controls={detailId}
        onClick={() => setOpen((v) => !v)}
        className="cl-hover-row flex w-full items-start gap-2 rounded px-1.5 py-2 text-left transition-colors"
      >
        <span aria-hidden="true" className="mt-[3px] w-2 shrink-0 text-[9px] text-muted">
          {open ? '▾' : '▸'}
        </span>
        <span aria-hidden="true" className="mt-[6px] h-1.5 w-1.5 shrink-0 rounded-full bg-danger" />
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="line-clamp-2 text-[12px] leading-snug text-primary" title={title}>
            {title}
          </span>
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {tags.map((t) => <TagChip key={`${t.kind}-${t.value}`} tag={t} />)}
            {shortLoc && (
              <span className="font-mono text-[10px] text-muted" title={fullLoc ?? shortLoc}>
                {shortLoc}
              </span>
            )}
            {typeof entry.durationMs === 'number' && entry.durationMs > 0 && (
              <span className="font-mono text-[10px] text-muted">{formatMs(entry.durationMs)}</span>
            )}
            {typeof entry.retry === 'number' && entry.retry > 0 && (
              <span className="font-mono text-[10px] text-warning" title="Playwright retried this test">
                retry {entry.retry}
              </span>
            )}
          </span>
        </span>
      </button>
      {open && (
        <div id={detailId} className="mb-2 ml-[26px] flex flex-col gap-2" data-testid={`failure-detail-${entry.name}`}>
          {message ? (
            <pre className="cl-code-shell m-0 max-h-[220px] overflow-auto whitespace-pre-wrap break-words p-2 text-[10.5px] leading-relaxed text-secondary scrollbar-thin">
              {message}
            </pre>
          ) : (
            // Never blank: a failure with no captured error still says so, and
            // still offers the spec.
            <p className="m-0 text-[11px] text-muted">
              No assertion error was captured — open the run detail for the full Playwright output.
            </p>
          )}
          {snippet && (
            <pre className="cl-code-shell m-0 max-h-[180px] overflow-auto whitespace-pre p-2 text-[10.5px] leading-relaxed text-secondary scrollbar-thin">
              {snippet}
            </pre>
          )}
          {fullLoc && (
            <div className="flex min-w-0 items-center gap-2">
              <button
                type="button"
                data-testid={`failure-open-${entry.name}`}
                onClick={() => { void openAt(fullLoc) }}
                className="cl-button shrink-0 px-2 py-0.5 text-[11px] text-accent"
              >
                Open spec ↗
              </button>
              <span className="min-w-0 truncate font-mono text-[10px] text-muted" title={fullLoc}>
                {fullLoc}
              </span>
            </div>
          )}
        </div>
      )}
    </li>
  )
}

function TagChip({ tag }: { tag: TestTag }) {
  const req = tag.kind === 'req'
  return (
    <span
      className={`rounded border px-1.5 py-px font-mono text-[10px] ${req ? 'border-accent/30 text-primary' : 'border-line text-muted'}`}
      title={tag.kind === 'path'
        ? `Exercises the ${PATH_DESC[tag.value] ?? tag.value} path`
        : tag.kind === 'req' ? `Covers requirement ${tag.value}` : `Variant ${tag.value}`}
    >
      @{tag.kind}-{tag.value}
    </span>
  )
}

/** Open the failing spec at its line. `location` is `<abs path>:<line>[:<col>]`. */
function openAt(location: string): Promise<unknown> {
  const parts = location.split(':')
  const col = parts.length >= 3 ? Number(parts.pop()) : undefined
  const line = parts.length >= 2 ? Number(parts.pop()) : undefined
  return api.openEditor({
    file: parts.join(':'),
    ...(Number.isFinite(line) ? { line: line as number } : {}),
    ...(Number.isFinite(col) ? { column: col as number } : {}),
  }).catch(() => {})
}

/** Resolve a failed entry into something a person can read. The real title
 *  comes from `knownTests` when the summary carried it; otherwise the slug is
 *  reversed, which recovers the words even though it can't recover the
 *  intra-word hyphens. */
export function parseFailure(
  entry: RunSummaryFailedEntry,
  knownTests?: RunSummary['knownTests'],
): ParsedFailure {
  const known = knownTests?.find((k) => (entry.id && k.id === entry.id) || k.name === entry.name)
  const raw = known?.title ?? (entry.name.startsWith('test-case-') ? deslug(entry.name) : entry.name)
  const { title, tags } = splitTags(raw)
  const loc = entry.location ?? entry.locations?.[0] ?? known?.location
  return {
    entry,
    title: title || entry.name,
    tags,
    shortLoc: shortLocation(loc),
    ...(loc ? { fullLoc: loc } : {}),
  }
}

/** Lift `@req-R4 @path-sad …` off the front (or anywhere) of a title. */
function splitTags(raw: string): { title: string; tags: TestTag[] } {
  const tags: TestTag[] = []
  const title = raw
    .replace(/@(req|path|variant)-([A-Za-z0-9_.]+)/g, (_m, kind: string, value: string) => {
      tags.push({ kind: kind as TestTag['kind'], value })
      return ''
    })
    .replace(/\s+/g, ' ')
    .trim()
  return { title, tags }
}

/** `test-case-req-r4-path-sad-a-request-is-refused` →
 *  `@req-R4 @path-sad a request is refused`. The leading tag segments are
 *  re-emitted in `@tag` form so `splitTags` can lift them the same way it does
 *  for a real title; requirement ids come back uppercase (`r4` → `R4`), which
 *  is how they are written everywhere else. */
function deslug(name: string): string {
  let rest = name.slice('test-case-'.length)
  const tags: string[] = []
  for (;;) {
    const m = /^(req|path|variant)-([a-z0-9.]+)-/.exec(rest)
    if (!m) break
    tags.push(`@${m[1]}-${m[1] === 'req' ? m[2].toUpperCase() : m[2]}`)
    rest = rest.slice(m[0].length)
  }
  return [...tags, rest.replace(/-/g, ' ')].join(' ').trim()
}

/** The readable tail of a test location — the last two path segments plus any
 *  `:line[:col]` suffix (`/Users/…/e2e/foo.spec.ts:199` → `e2e/foo.spec.ts:199`). */
export function shortLocation(loc: string | undefined): string {
  if (!loc) return ''
  return loc.split('/').slice(-2).join('/')
}

function formatMs(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`
}
