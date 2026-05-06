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
  return compacted.slice(0, 8)
}

function preferredScreenshots(artifacts: PlaywrightArtifact[]): PlaywrightArtifact[] {
  const screenshots = artifacts
    .filter((a) => a.kind === 'screenshot')
    .sort((a, b) => (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0))
  const final = screenshots.find((a) => /canary-lab-final-page/i.test(`${a.name} ${a.path}`))
  return (final ? [final] : screenshots.slice(0, 1))
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
  if (lower.includes('navigate')) return quoted ? `Navigate ${quoted}` : 'Navigate'
  if (lower.includes('click')) return quoted ? `Click ${quoted}` : 'Click'
  if (lower.includes('fill')) return quoted ? `Fill ${quoted}` : 'Fill'
  if (lower.includes('press')) return quoted ? `Press ${quoted}` : 'Press'
  if (lower.includes('select')) return quoted ? `Select ${quoted}` : 'Select'
  if (lower.includes('check')) return quoted ? `Check ${quoted}` : 'Check'
  if (lower.includes('expect')) return quoted ? `Expect ${quoted}` : 'Expect'
  return isBrowserAction(title) ? title.replace(/\s+/g, ' ').slice(0, 80) : null
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
