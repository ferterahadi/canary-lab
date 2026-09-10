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

/** How many failures the summary shows before handing off. A run with 12
 *  failures rendered 12 two-line rows, which made this band four times taller
 *  than everything else on the stage put together — the summary became the
 *  longest surface in the app, which is the thing R82 set out to stop. Six is
 *  enough to see the shape of the failure (one spec? one requirement? one
 *  variant?); the rest are one click away, where they can be read properly. */
const VISIBLE_FAILURES = 6

export function FailingTests({
  failing,
  knownTests,
  onOpenTest,
  onOpenAll,
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
  /** Open the run detail on the whole list — the destination for the failures
   *  past `VISIBLE_FAILURES`. Omitted → the remainder is stated, not offered. */
  onOpenAll?: () => void
  testId?: string
}) {
  if (failing.length === 0) return null
  const parsed = failing.map((entry) => parseFailure(entry, knownTests))
  const shown = parsed.slice(0, VISIBLE_FAILURES)
  const hidden = parsed.length - shown.length
  return (
    // A section of the run hero, not its own card — the run stays ONE object
    // (R80). Same rubric + dashed-rule header the previous-runs band uses.
    <section className="mt-4 min-w-0" data-testid={testId}>
      <div className="mb-1.5 flex items-center gap-2">
        <span className="cl-rubric">Failing tests</span>
        <span className="h-px flex-1 border-t border-dashed border-line" />
        <span className="cl-count-chip">{failing.length}</span>
      </div>
      <ul className="m-0 flex list-none flex-col p-0">
        {shown.map((f, i) => (
          <FailureRow
            key={`${f.entry.id ?? f.entry.name}-${i}`}
            failure={f}
            {...(onOpenTest ? { onOpen: () => onOpenTest(f.entry.name) } : {})}
          />
        ))}
      </ul>
      {hidden > 0 && (
        <div className="mt-2" style={{ paddingLeft: HERO_ROW.TEXT_INDENT }}>
          {onOpenAll ? (
            <button
              type="button"
              data-testid={`${testId}-more`}
              onClick={onOpenAll}
              className="cl-type-meta text-muted transition-colors hover:text-secondary hover:underline"
            >
              {hidden} more on the run detail →
            </button>
          ) : (
            <span className="cl-type-meta text-muted">{hidden} more not shown</span>
          )}
        </div>
      )}
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
        className="mt-[5px] flex shrink-0 items-center justify-center"
        style={{ width: HERO_ROW.DOT }}
      >
        <span className="h-1.5 w-1.5 rounded-full bg-danger" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        {/* The title WRAPS rather than truncating — the words that separate two
            failures of the same requirement sit at the end of the sentence. */}
        <span className="line-clamp-2 cl-type-data text-primary group-hover:underline" title={title}>
          {title}
        </span>
        <span className="mt-0.5 flex min-w-0 flex-wrap items-baseline gap-x-2.5 font-mono cl-type-meta">
          {tags.map((t) => <TagText key={`${t.kind}-${t.value}`} tag={t} />)}
          {shortLoc && (
            <span className="text-muted" title={fullLoc ?? shortLoc}>
              {shortLoc}
            </span>
          )}
          {typeof entry.durationMs === 'number' && entry.durationMs > 0 && (
            <span className="text-muted">{formatMs(entry.durationMs)}</span>
          )}
          {typeof entry.retry === 'number' && entry.retry > 0 && (
            <span className="text-warning" title="Playwright retried this test">
              retry {entry.retry}
            </span>
          )}
        </span>
      </span>
    </>
  )
  return (
    // No divider, no fill, no rounding: twelve of these inside a card turned it
    // into a striped data grid boxed inside a panel, and a hairline drawn out to
    // the card's border read as the card splitting in two. A failure is a line
    // of text under the run it belongs to — the dot marks it, the hover
    // underlines the title, and the card keeps ONE surface.
    <li data-testid={`failing-test-${entry.name}`}>
      {onOpen ? (
        <button
          type="button"
          data-testid={`failing-open-${entry.name}`}
          onClick={onOpen}
          title="Open this failure on the run detail"
          className="group flex w-full items-start gap-2 py-1.5 text-left"
        >
          {body}
        </button>
      ) : (
        <div className="flex w-full items-start gap-2 py-1.5">{body}</div>
      )}
    </li>
  )
}

/** A test's `@req-` / `@path-` / `@variant-` label. Plain mono text, not a
 *  bordered chip: three of them per row over twelve rows put thirty-six boxes
 *  in one card, and the `@req-` chip's accent border made every row compete for
 *  the one accent the card is allowed (the run's own arrow). The literal
 *  `@req-R4` spelling is what carries the vocabulary across to the coverage
 *  ledger, and that survives with no chrome at all — a requirement reads one
 *  step brighter than the incidentals beside it. */
function TagText({ tag }: { tag: TestTag }) {
  return (
    <span
      className={tag.kind === 'req' ? 'text-secondary' : 'text-muted'}
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
