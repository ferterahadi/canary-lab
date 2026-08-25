import type { RunSummary, RunSummaryFailedEntry } from '@/shared/api/types'
import { HERO_ROW } from './stage-meta'

// The failing tests, rendered as evidence instead of a list of truncated slugs.
//
// Before this, the run hero showed five 11.5px rows of `test-case-req-r4-path-
// sad-a-request-with-no-bot-challenge-token-is-refused-before-a…` — the
// SLUGIFIED name, ellipsised exactly where the discriminating words live, with
// the failure reason thrown away entirely. Two failures looked identical and
// neither said why it failed.
//
// Each failure is one row: the human title on its own line (recovered from
// `knownTests`, or de-slugified), its `@req-`/`@path-` tags as the same mono
// chips the coverage ledger uses, and the location · duration · retry
// underneath.
//
// R82 — the row does NOT expand. The flight's run stage is the SUMMARY of a
// run; the assertion error, the code snippet and the spec itself are run-detail
// content, and having them here made the summary the second-longest surface in
// the app. Clicking a row now opens that failure ON the run detail (the
// Playwright tab, scrolled to this test) instead of unfolding a copy of it
// here — one destination rather than four disclosures.

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

const PATH_DESC: Record<string, string> = { happy: 'happy', sad: 'failure', edge: 'edge-case' }

export function FailingTests({
  failing,
  knownTests,
  onOpenTest,
  testId = 'run-hero-failing',
}: {
  failing: RunSummaryFailedEntry[]
  /** The run's known tests — carries each test's REAL title, which the failed
   *  entry only has in slug form. Matched by id, then by name. */
  knownTests?: RunSummary['knownTests']
  /** Open this failure on the run detail (R82). Receives the failed entry's
   *  `name` — the same key the run detail's Playwright tab matches playback
   *  tests on, so it lands on this exact test. Omitted → rows are inert text. */
  onOpenTest?: (testName: string) => void
  testId?: string
}) {
  if (failing.length === 0) return null
  const parsed = failing.map((entry) => parseFailure(entry, knownTests))
  return (
    // A section of the run hero, not its own card — the run stays ONE object
    // (R80). Same rubric + dashed-rule header the previous-runs band uses.
    <section className="mt-3 min-w-0" data-testid={testId}>
      <div className="mb-1 flex items-center gap-2">
        <span className="cl-rubric">Failing tests</span>
        <span className="h-px flex-1 border-t border-dashed border-line" />
        <span className="cl-count-chip">{failing.length}</span>
      </div>
      <ul className="m-0 flex list-none flex-col p-0">
        {parsed.map((f, i) => (
          <FailureRow
            key={`${f.entry.id ?? f.entry.name}-${i}`}
            failure={f}
            {...(onOpenTest ? { onOpen: () => onOpenTest(f.entry.name) } : {})}
          />
        ))}
      </ul>
    </section>
  )
}

/** One failure: identity only — status dot, title, tags, location · duration ·
 *  retry. The title WRAPS (up to two lines) rather than truncating; the words that
 *  distinguish two failures of the same requirement sit at the end of the
 *  sentence, which is exactly what an ellipsis was eating.
 *
 *  The whole row is the click target and it goes to the run detail, at this test.
 *  No disclosure: the assertion error and the spec are the run detail's job. */
function FailureRow({ failure, onOpen }: { failure: ParsedFailure; onOpen?: () => void }) {
  const { entry, title, tags, shortLoc, fullLoc } = failure
  const body = (
    <>
      {/* Smaller dot than the run row's, centred in that row's dot lane — see
          HERO_ROW. Keeps the subordinate weight without a second left edge. */}
      <span
        aria-hidden="true"
        className="mt-[6px] flex shrink-0 items-center justify-center"
        style={{ width: HERO_ROW.DOT }}
      >
        <span className="h-1.5 w-1.5 rounded-full bg-danger" />
      </span>
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
    </>
  )
  return (
    <li className="border-t border-line-subtle first:border-t-0" data-testid={`failing-test-${entry.name}`}>
      {onOpen ? (
        <button
          type="button"
          data-testid={`failing-open-${entry.name}`}
          onClick={onOpen}
          title="Open this failure on the run detail"
          className="cl-hover-row flex w-full items-start gap-2 rounded py-2 text-left transition-colors"
          style={{ paddingInline: HERO_ROW.GUTTER }}
        >
          {body}
        </button>
      ) : (
        <div className="flex w-full items-start gap-2 py-2" style={{ paddingInline: HERO_ROW.GUTTER }}>{body}</div>
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
        : tag.kind === 'req' ? `Covers requirement ${tag.value}` : `Only tested for: ${tag.value}`}
    >
      @{tag.kind}-{tag.value}
    </span>
  )
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
