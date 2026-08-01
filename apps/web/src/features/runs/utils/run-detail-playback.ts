import type {
  PlaywrightArtifact,
  PlaywrightArtifactGroup,
  PlaywrightArtifactPolicy,
  PlaywrightPlaybackEvent,
  PlaywrightRetainedArtifactMode,
  PlaywrightScreenshotMode,
  RepoBranchSnapshot,
  ServiceManifestEntry,
} from '@/shared/api/types'
import { parseLocation } from '@/shared/test-numbering'

export interface PlaybackTest {
  name: string
  title: string
  /** Source location (`file:line[:col]`) — used to resolve the stable test id. */
  location?: string
  startedAt?: string
  endedAt?: string
  status?: string
  passed?: boolean
  durationMs?: number
  retry?: number
  error?: { message: string; snippet?: string }
  steps: Array<{ title: string; category: string; ended: boolean }>
}

export interface PlaybackArtifacts {
  screenshots: PlaywrightArtifact[]
  links: PlaywrightArtifact[]
  screenshotMode: PlaywrightScreenshotMode
}

export const DEFAULT_PLAYWRIGHT_ARTIFACT_POLICY: PlaywrightArtifactPolicy = {
  screenshot: 'only-on-failure',
  video: 'off',
  trace: 'retain-on-failure',
}

export function playbackTests(events?: PlaywrightPlaybackEvent[]): PlaybackTest[] {
  const tests = new Map<string, PlaybackTest>()
  const activeKeyByName = new Map<string, string>()
  const latestKeyByName = new Map<string, string>()
  // Tracks the `location` (file:line) for each attempt's key — only test-begin
  // and test-end events carry location, so we record it as we see them.
  const locationByKey = new Map<string, string>()
  for (const event of events ?? []) {
    let key = activeKeyByName.get(event.test.name) ?? latestKeyByName.get(event.test.name) ?? event.test.name
    if (event.type === 'test-begin') {
      key = `${event.test.name}:${event.time}`
      activeKeyByName.set(event.test.name, key)
      latestKeyByName.set(event.test.name, key)
    }
    if ((event.type === 'test-begin' || event.type === 'test-end') && event.test.location) {
      locationByKey.set(key, event.test.location)
    }
    const current = tests.get(key) ?? { name: event.test.name, title: event.test.title, steps: [] }
    current.title = event.test.title || current.title
    if (event.type === 'test-begin') current.startedAt = event.time
    if (event.type === 'step-begin') {
      current.steps.push({ title: event.step.title, category: event.step.category, ended: false })
    }
    if (event.type === 'step-end') {
      const open = [...current.steps].reverse().find((s) => s.title === event.step.title && !s.ended)
      if (open) open.ended = true
      else current.steps.push({ title: event.step.title, category: event.step.category, ended: true })
    }
    if (event.type === 'test-end') {
      current.status = event.status
      current.passed = event.passed
      current.durationMs = event.durationMs
      current.retry = event.retry
      current.error = event.error
      current.endedAt = event.time
      activeKeyByName.delete(event.test.name)
    }
    tests.set(key, current)
    latestKeyByName.set(event.test.name, key)
  }
  // Collapse attempts to one entry per (name, spec file). Retries and
  // heal-cycle reruns fold into the latest attempt — the line number is
  // deliberately ignored because heal edits shift a test's line between
  // cycles (e.g. :205 → :222) while it stays the same test. Two distinct
  // tests that happen to share a title (and therefore a `name`) but live in
  // different files stay as separate entries — the export HTML disambiguates
  // them via positional anchor IDs. Map preserves first-seen identity order,
  // last write wins so the latest attempt is kept.
  // Carries the test alongside its key: every entry here comes straight out of
  // `tests`, so re-looking it up afterwards only added a `has`/`get` pair whose
  // miss arm nothing could reach.
  const latestByIdentity = new Map<string, { key: string; test: PlaybackTest }>()
  for (const [key, test] of tests.entries()) {
    const file = parseLocation(locationByKey.get(key))?.file ?? ''
    const identity = `${test.name}@${file}`
    latestByIdentity.set(identity, { key, test })
  }
  return [...latestByIdentity.values()]
    .map(({ key, test }) => ({
      ...test,
      location: test.location ?? locationByKey.get(key),
      steps: compactPlaybackSteps(test.steps),
    }))
}

export function artifactsForPlayback(
  testName: string,
  artifactGroups: PlaywrightArtifactGroup[] | undefined,
  policy: PlaywrightArtifactPolicy | undefined,
): PlaybackArtifacts {
  const effective = policy ?? DEFAULT_PLAYWRIGHT_ARTIFACT_POLICY
  const artifacts = artifactGroups?.find((g) => g.testName === testName)?.artifacts ?? []
  return {
    screenshotMode: effective.screenshot,
    screenshots: effective.screenshot === 'off' ? [] : preferredScreenshots(artifacts),
    links: artifacts.filter((a) => (
      (a.kind === 'trace' && artifactModeEnabled(effective.trace)) ||
      (a.kind === 'video' && artifactModeEnabled(effective.video))
    )),
  }
}

export function branchForService(
  service: Pick<ServiceManifestEntry, 'cwd' | 'repoName'>,
  branches: RepoBranchSnapshot[],
): RepoBranchSnapshot | null {
  // Repo name first, path containment second.
  //
  // A run that isolates its services — the default now — starts each one in a
  // per-run git worktree at `<workspace>/logs/runs/<id>/worktrees/<repo>`. That
  // cwd is NOT a child of the repo snapshot's own `path`
  // (`~/Documents/<repo>`), so containment alone matched nothing and the ref
  // silently vanished from every isolated run's service card and service tab.
  // The manifest already records `service.repoName === repo.name`, which is the
  // relationship the snapshot is actually keyed on.
  const named = service.repoName?.trim()
  if (named) {
    const byName = branches.find((repo) => repo.name === named)
    if (byName) return byName
  }
  // Fallback for services with no `repoName` (older manifests, and services
  // running straight out of a checkout): deepest containing repo wins, so a
  // nested repo beats its parent.
  const cwd = normalizePath(service.cwd)
  let best: RepoBranchSnapshot | null = null
  for (const repo of branches) {
    const repoPath = normalizePath(repo.path)
    if (!isSameOrChild(repoPath, cwd)) continue
    if (!best || repoPath.length > normalizePath(best.path).length) best = repo
  }
  return best
}

export function branchLabel(repo: RepoBranchSnapshot): string {
  return repo.detached ? 'detached' : repo.branch ?? 'unknown'
}

export function branchTooltip(service: Pick<ServiceManifestEntry, 'cwd'>, repo: RepoBranchSnapshot): string {
  const label = branchLabel(repo)
  const parts = [
    `repo: ${repo.name}`,
    `branch: ${label}`,
    ...(repo.expectedBranch ? [`expected: ${repo.expectedBranch}`] : []),
    ...(repo.dirty ? ['dirty: yes'] : []),
    ...(repo.expectedBranch && repo.branch !== repo.expectedBranch ? ['mismatch: yes'] : []),
    `repo path: ${repo.path}`,
    `service cwd: ${service.cwd}`,
  ]
  return parts.join('\n')
}

type PlaybackStep = PlaybackTest['steps'][number]

/** A step that survived filtering. `title: null` marks an assertion whose only
 *  content was the matcher name (`Expect "toBe"`): one such row says nothing,
 *  eleven in a column say nothing eleven times — but the fact that eleven
 *  assertions ran is worth one line, so they collapse into a tally. */
interface MappedStep {
  step: PlaybackStep
  title: string | null
}

function compactPlaybackSteps(steps: PlaybackTest['steps']): PlaybackTest['steps'] {
  const mapped = steps.flatMap<MappedStep>((step) => {
    // Hooks, fixtures and attachments are Playwright's own bookkeeping —
    // `Before Hooks`, `Fixture "request"`, `Attach "canary-lab-final-page"`.
    if (step.category === 'hook' || step.category === 'fixture' || step.category === 'test.attach') return []
    if (isBareAssertion(step.title, step.category)) return [{ step, title: null }]
    const title = compactStepTitle(step.title, step.category)
    return title ? [{ step, title }] : []
  })

  // Collapse each consecutive run of bare assertions into one tally, in place,
  // so the surrounding steps keep their order.
  const out: PlaybackTest['steps'] = []
  const pending: PlaybackStep[] = []
  const flush = (): void => {
    if (pending.length === 0) return
    out.push({
      ...pending[pending.length - 1],
      // A tally is only finished when every assertion under it is: one still
      // open must not be reported as done.
      ended: pending.every((step) => step.ended),
      title: `Verified ${pending.length} assertion${pending.length === 1 ? '' : 's'}`,
    })
    pending.length = 0
  }
  for (const entry of mapped) {
    if (entry.title === null) {
      pending.push(entry.step)
      continue
    }
    flush()
    out.push({ ...entry.step, title: entry.title })
  }
  flush()
  return out
}

/** An `expect` step that named a matcher and nothing else. */
function isBareAssertion(title: string, category: string): boolean {
  if (category !== 'expect' && !/^[Ee]xpect/.test(title)) return false
  const matcher = EXPECT_MATCHER_RE.exec(title)
  if (!matcher) return false
  const rest = title.slice(matcher[0].length)
  return describeActionTarget(rest, rest.match(/['"]([^'"]{1,80})['"]/)?.[1]) === null
}

function preferredScreenshots(artifacts: PlaywrightArtifact[]): PlaywrightArtifact[] {
  const screenshots = artifacts
    .filter((a) => a.kind === 'screenshot')
    .sort((a, b) => (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0))
  const finalScreenshots = screenshots.filter((a) => /canary-lab-final-page/i.test(`${a.name} ${a.path}`))
  const final = finalScreenshots.find((a) => !isAttachmentPath(a.path)) ?? finalScreenshots[0]
  return (final ? [final] : screenshots.slice(0, 1))
}

function isAttachmentPath(pathLabel: string): boolean {
  return pathLabel.split(/[\\/]+/).includes('attachments')
}

/** Playwright's own plumbing steps — present in every test, informative in none. */
const STEP_PLUMBING = [
  'launch browser',
  'create context',
  'create page',
  'close context',
  'create request context',
  'dispose request context',
  'wait for selector',
  'wait for load state',
]

/** `POST "/oauth/token"` — an API suite's steps are HTTP calls, and they are the
 *  most informative rows on the card. The old title-only matcher recognised no
 *  verb in them and dropped every one. */
const API_REQUEST_RE = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+["']([^"']+)["']/i

/** `Expect "toBe"` / `Expect "toBeVisible" getByRole(…)` — Playwright's generic
 *  assertion step. The quoted token is the MATCHER, not the target, so the old
 *  code read it as a target and rendered 11 identical `Verified toBe` rows for
 *  an API test. Matchers are universally named `to<Something>` (optionally
 *  negated), which is what separates them from an author's own message. */
const EXPECT_MATCHER_RE = /^[Ee]xpect(?:\.soft|\.poll)?\s*["'](not[. ])?(to[A-Z]\w*)["']/

/**
 * One playback step in plain words, or `null` to drop it.
 *
 * Category matters: the same word means different things in `pw:api` (a real
 * HTTP request) and `test.step` (this harness's own `page.click` marker), and a
 * bare matcher name in an `expect` step is not a target no matter how much it
 * looks like one.
 */
function compactStepTitle(title: string, category?: string): string | null {
  const lower = title.toLowerCase()
  if (STEP_PLUMBING.some((noise) => lower.includes(noise))) return null
  if (lower === 'screenshot') return null

  const api = API_REQUEST_RE.exec(title)
  if (api) return `${api[1].toUpperCase()} ${api[2]}`

  // `page.click` / `page.goto` — the harness's own step names. Rewrite to the
  // same verb vocabulary the raw Playwright titles use, then fall through.
  const harnessVerb = /^page\.([a-z_]+)/i.exec(title)?.[1]
  if (harnessVerb) return harnessStepLabel(harnessVerb)

  const quoted = title.match(/['"]([^'"]{1,80})['"]/)?.[1]

  // Assertions are settled BEFORE the action verbs, because a matcher name
  // contains one: `Expect "toBeChecked" …` hits `includes('check')` and would
  // be reported as a *click on a checkbox* rather than as an assertion.
  if (category === 'expect' || lower.startsWith('expect')) {
    const matcher = EXPECT_MATCHER_RE.exec(title)
    if (matcher) {
      // Look for the target in what FOLLOWS the matcher, never in the matcher
      // itself: `Expect "toBeVisible" getByRole('button', { name: 'Authorize' })`
      // is about the Authorize button; `Expect "toBe"` is about nothing the UI
      // can name, so it earns no row.
      const rest = title.slice(matcher[0].length)
      const target = describeActionTarget(rest, rest.match(/['"]([^'"]{1,80})['"]/)?.[1])
      if (!target) return null
      // The negation is load-bearing. Dropping it renders `not toBeVisible` as
      // "is visible" — the opposite of what the test asserted, in a pane whose
      // whole job is to be evidence.
      const phrase = matcherPhrase(matcher[2], Boolean(matcher[1]))
      return `Verified ${target} ${phrase}`.trimEnd()
    }
    // Not the matcher shape. Either the author supplied their own message
    // (`expect(x, 'auth probe should return a userId')` — Playwright uses the
    // message as the step title) or the quoted token names what was checked.
    // Both are the best line available, so keep them.
    if (lower.startsWith('expect')) return `Verified ${describeActionTarget(title, quoted) ?? 'expectation'}`
    return title.replace(/\s+/g, ' ').slice(0, 120)
  }

  if (lower.includes('navigate')) return quoted ? `Opened ${quoted}` : 'Opened page'
  if (lower.includes('click')) return `Clicked ${describeActionTarget(title, quoted) ?? 'page element'}`
  if (lower.includes('fill')) return describeFillAction(title) ?? 'Filled field'
  if (lower.includes('press')) return quoted ? `Pressed ${quoted}` : 'Pressed key'
  if (lower.includes('select')) return quoted ? `Selected ${friendlyTarget(quoted)}` : 'Selected option'
  if (lower.includes('check')) return `Checked ${describeActionTarget(title, quoted) ?? 'option'}`

  return isBrowserAction(title) ? title.replace(/\s+/g, ' ').slice(0, 80) : null
}

function harnessStepLabel(verb: string): string | null {
  switch (verb.toLowerCase()) {
    case 'goto': return 'Opened page'
    case 'click': return 'Clicked page element'
    case 'fill': return 'Filled field'
    case 'screenshot': return null
    case '_expect': return null
    default: return null
  }
}

/** Matcher name → the tail of a sentence. Unknown matchers add nothing, so they
 *  return an empty string and the row reads `Verified <target>` — but a negated
 *  unknown matcher still has to say so, or the row asserts the opposite of the
 *  test. */
function matcherPhrase(matcher: string, negated = false): string {
  const phrase = ((): string => {
    switch (matcher) {
      case 'toBeVisible': return 'is visible'
      case 'toBeHidden': return 'is hidden'
      case 'toBeEnabled': return 'is enabled'
      case 'toBeDisabled': return 'is disabled'
      case 'toBeChecked': return 'is checked'
      case 'toHaveText': return 'has the expected text'
      case 'toHaveValue': return 'has the expected value'
      case 'toHaveURL': return 'has the expected URL'
      case 'toContainText': return 'contains the expected text'
      default: return ''
    }
  })()
  if (!negated) return phrase
  // `is visible` → `is not visible`; an unphrased matcher falls back to naming
  // the matcher itself rather than silently dropping the negation.
  if (phrase.startsWith('is ')) return `is not ${phrase.slice(3)}`
  if (phrase.startsWith('has ')) return `does not have ${phrase.slice(4)}`
  if (phrase.startsWith('contains ')) return `does not contain ${phrase.slice(9)}`
  return `does not match ${matcher}`
}

/** `/^authorize$/i` → `authorize`. Anchors and escapes are regex syntax, not
 *  something a reader of the trace needs to see. */
function unanchorPattern(pattern: string): string {
  return pattern
    .replace(/^\^/, '')
    .replace(/\$$/, '')
    // Character classes and their quantifiers are wildcards standing in for
    // text nobody can predict — `/^Pickup\\s/` matches a button labelled
    // "Pickup". Dropping the backslash alone rendered it "Pickups", a word that
    // appears neither in the test nor on the page.
    .replace(/\\[dDsSwWbB]\+?\*?\??/g, ' ')
    // What is left is an escaped literal (`example\\.com`, `Order \\#`).
    .replace(/\\(?=.)/g, '')
    // An alternation is a set of acceptable labels, not a pipe-delimited string.
    .replace(/\|/g, ' / ')
    .replace(/\s+/g, ' ')
    // A trailing separator left behind by a stripped wildcard reads as a typo.
    .replace(/[\s,;:.-]+$/, '')
    .trim()
}

function friendlyTarget(target: string): string {
  return target.trim()
    .replace(/^Button$/i, 'button')
    .replace(/^Locator$/i, 'field')
}

function describeFillAction(title: string): string | null {
  const value = firstActionValue(title)
  const target = describeActionTarget(title.slice(value?.raw.length ?? 0), undefined)
  if (value && value.text.length > 0 && target) return `Entered ${value.text} in ${target}`
  if (value && value.text.length > 0) return `Entered ${value.text}`
  if (target) return `Cleared ${target}`
  return null
}

function firstActionValue(title: string): { text: string; raw: string } | null {
  const match = title.match(/(['"])(.*?)\1/)
  return match ? { text: match[2], raw: match[0] } : null
}

function describeActionTarget(title: string, quoted: string | undefined): string | null {
  const roleName = title.match(/getByRole\([^)]*name:\s*['"]([^'"]+)['"]/i)?.[1]
  if (roleName) return roleName

  // Regex-literal locators are as common as string ones in this corpus
  // (`{ name: /^authorize$/i }`, `getByText(/token created/i)`), and reading
  // only the quoted form collapsed 850+ distinct rows to a bare `button`.
  const roleRegex = title.match(/getByRole\([^)]*name:\s*\/(.+?)\/[gimsuy]*\s*\}/i)?.[1]
  if (roleRegex) return unanchorPattern(roleRegex)

  const textRegex = title.match(/getByText\(\/(.+?)\/[gimsuy]*\)/i)?.[1]
  if (textRegex) return unanchorPattern(textRegex)

  const label = title.match(/getByLabel\(['"]([^'"]+)['"]/i)?.[1]
  if (label) return label

  const placeholder = title.match(/getByPlaceholder\(['"]([^'"]+)['"]/i)?.[1]
  if (placeholder) return placeholder

  const text = title.match(/getByText\(['"]([^'"]+)['"]/i)?.[1]
  if (text) return text

  const testId = title.match(/getByTestId\(['"]([^'"]+)['"]/i)?.[1]
  if (testId) return `${testId} control`

  const locator = title.match(/locator\(['"]([^'"]+)['"]/i)?.[1]
  if (locator) return friendlyLocator(locator)

  if (quoted && !looksLikeSelector(quoted)) return friendlyTarget(quoted)
  return null
}

function friendlyLocator(locator: string): string {
  if (/iframe/i.test(locator)) return 'embedded login frame'
  if (/^#[\w-]+$/.test(locator)) return `${locator.slice(1)} element`
  if (/^\.[\w-]+$/.test(locator)) return `${locator.slice(1)} element`
  return 'page element'
}

function looksLikeSelector(value: string): boolean {
  return /^(?:#|\.|locator\(|css=|xpath=|\[|\/\/)/i.test(value.trim())
}

function isBrowserAction(title: string): boolean {
  return /(?:^|\b)(page|locator|getBy|navigate|click|fill|press|select|check|uncheck|expect)\b/i.test(title)
}

function artifactModeEnabled(mode: PlaywrightRetainedArtifactMode): boolean {
  return mode !== 'off'
}

function normalizePath(input: string): string {
  return input.replace(/\/+$/, '') || '/'
}

function isSameOrChild(parent: string, child: string): boolean {
  return child === parent || child.startsWith(`${parent}/`)
}
