import type {
  PlaywrightArtifact,
  PlaywrightArtifactGroup,
  PlaywrightArtifactPolicy,
  PlaywrightPlaybackEvent,
  PlaywrightRetainedArtifactMode,
  PlaywrightScreenshotMode,
  RepoBranchSnapshot,
  ServiceManifestEntry,
} from '../api/types'

export interface PlaybackTest {
  name: string
  title: string
  startedAt?: string
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
  for (const event of events ?? []) {
    const key = event.test.name
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
    }
    tests.set(key, current)
  }
  return [...tests.values()].map((test) => ({ ...test, steps: compactPlaybackSteps(test.steps) }))
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
  service: Pick<ServiceManifestEntry, 'cwd'>,
  branches: RepoBranchSnapshot[],
): RepoBranchSnapshot | null {
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

function compactPlaybackSteps(steps: PlaybackTest['steps']): PlaybackTest['steps'] {
  const compacted = steps.flatMap((step) => {
    if (step.category === 'hook' || step.category === 'fixture') return []
    const title = compactStepTitle(step.title)
    return title ? [{ ...step, title }] : []
  })
  return compacted
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

function compactStepTitle(title: string): string | null {
  const lower = title.toLowerCase()
  if (
    lower.includes('launch browser') ||
    lower.includes('create context') ||
    lower.includes('create page') ||
    lower.includes('close context') ||
    lower.includes('wait for selector')
  ) return null

  const quoted = title.match(/['"]([^'"]{1,80})['"]/)?.[1]
  if (lower.includes('navigate')) return quoted ? `Opened ${quoted}` : 'Opened page'
  if (lower.includes('click')) return `Clicked ${describeActionTarget(title, quoted) ?? 'page element'}`
  if (lower.includes('fill')) return describeFillAction(title) ?? 'Filled field'
  if (lower.includes('press')) return quoted ? `Pressed ${quoted}` : 'Pressed key'
  if (lower.includes('select')) return quoted ? `Selected ${friendlyTarget(quoted)}` : 'Selected option'
  if (lower.includes('check')) return `Checked ${describeActionTarget(title, quoted) ?? 'option'}`
  if (lower.includes('expect')) return `Verified ${describeActionTarget(title, quoted) ?? 'expectation'}`
  return isBrowserAction(title) ? title.replace(/\s+/g, ' ').slice(0, 80) : null
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
