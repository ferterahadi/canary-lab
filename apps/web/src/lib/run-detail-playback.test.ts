import { describe, expect, it } from 'vitest'
import type {
  PlaywrightArtifactGroup,
  PlaywrightPlaybackEvent,
  RepoBranchSnapshot,
  ServiceManifestEntry,
} from '../api/types'
import {
  DEFAULT_PLAYWRIGHT_ARTIFACT_POLICY,
  artifactsForPlayback,
  branchForService,
  branchLabel,
  branchTooltip,
  playbackTests,
} from './run-detail-playback'

describe('playbackTests', () => {
  it('returns no tests when events are missing', () => {
    expect(playbackTests()).toEqual([])
  })

  it('groups test lifecycle events and keeps browser-facing steps', () => {
    const events: PlaywrightPlaybackEvent[] = [
      {
        type: 'test-begin',
        time: '2026-01-01T00:00:00.000Z',
        test: { name: 'auth.spec.ts:login', title: 'logs in', location: 'auth.spec.ts:1' },
      },
      {
        type: 'step-begin',
        time: '2026-01-01T00:00:01.000Z',
        test: { name: 'auth.spec.ts:login', title: 'logs in' },
        step: { title: 'Before Hooks', category: 'hook' },
      },
      {
        type: 'step-begin',
        time: '2026-01-01T00:00:02.000Z',
        test: { name: 'auth.spec.ts:login', title: 'logs in' },
        step: { title: 'Navigate to "/login"', category: 'pw:api' },
      },
      {
        type: 'step-end',
        time: '2026-01-01T00:00:03.000Z',
        test: { name: 'auth.spec.ts:login', title: 'logs in' },
        step: { title: 'Navigate to "/login"', category: 'pw:api' },
      },
      {
        type: 'test-end',
        time: '2026-01-01T00:00:04.000Z',
        test: { name: 'auth.spec.ts:login', title: 'logs in after retry', location: 'auth.spec.ts:1' },
        status: 'passed',
        passed: true,
        durationMs: 40,
        retry: 1,
      },
    ]

    expect(playbackTests(events)).toEqual([
      {
        name: 'auth.spec.ts:login',
        title: 'logs in after retry',
        startedAt: '2026-01-01T00:00:00.000Z',
        status: 'passed',
        passed: true,
        durationMs: 40,
        retry: 1,
        error: undefined,
        steps: [{ title: 'Navigate /login', category: 'pw:api', ended: true }],
      },
    ])
  })

  it('records orphan step endings but hides non-browser noise from playback', () => {
    const events: PlaywrightPlaybackEvent[] = [
      {
        type: 'step-end',
        time: '2026-01-01T00:00:01.000Z',
        test: { name: 'setup.spec.ts:seed', title: 'seeds data' },
        step: { title: 'seed database', category: 'test.step' },
      },
      {
        type: 'test-end',
        time: '2026-01-01T00:00:02.000Z',
        test: { name: 'setup.spec.ts:seed', title: '', location: 'setup.spec.ts:1' },
        status: 'failed',
        passed: false,
        durationMs: 20,
        retry: 0,
        error: { message: 'boom', snippet: 'expect(false).toBe(true)' },
      },
    ]

    expect(playbackTests(events)).toEqual([
      {
        name: 'setup.spec.ts:seed',
        title: 'seeds data',
        status: 'failed',
        passed: false,
        durationMs: 20,
        retry: 0,
        error: { message: 'boom', snippet: 'expect(false).toBe(true)' },
        steps: [],
      },
    ])
  })

  it('compacts common Playwright step titles and limits visible steps', () => {
    const events: PlaywrightPlaybackEvent[] = [
      {
        type: 'test-begin',
        time: '2026-01-01T00:00:00.000Z',
        test: { name: 'flow', title: 'Flow', location: 'flow.spec.ts:1' },
      },
      ...[
        'launch browser',
        'create context',
        'create page',
        'close context',
        'wait for selector "#ready"',
        'Navigate',
        'Click "Submit"',
        'Fill "Email"',
        'Press "Enter"',
        'Select "Singapore"',
        'Check "Terms"',
        'Expect "Success"',
        'page screenshot',
      ].map((title) => ({
        type: 'step-begin' as const,
        time: '2026-01-01T00:00:01.000Z',
        test: { name: 'flow', title: 'Flow' },
        step: { title, category: 'pw:api' },
      })),
      {
        type: 'test-end',
        time: '2026-01-01T00:00:02.000Z',
        test: { name: 'flow', title: 'Flow', location: 'flow.spec.ts:1' },
        status: 'passed',
        passed: true,
        durationMs: 1,
        retry: 0,
      },
    ]

    expect(playbackTests(events)[0].steps.map((step) => step.title)).toEqual([
      'Navigate',
      'Click Submit',
      'Fill Email',
      'Press Enter',
      'Select Singapore',
      'Check Terms',
      'Expect Success',
      'page screenshot',
    ])
  })

  it('uses generic labels when compactable actions have no quoted target', () => {
    const events: PlaywrightPlaybackEvent[] = [
      {
        type: 'test-begin',
        time: '2026-01-01T00:00:00.000Z',
        test: { name: 'generic', title: 'Generic', location: 'generic.spec.ts:1' },
      },
      ...[
        'Click',
        'Fill',
        'Press',
        'Select',
        'Check',
        'Expect',
      ].map((title) => ({
        type: 'step-begin' as const,
        time: '2026-01-01T00:00:01.000Z',
        test: { name: 'generic', title: 'Generic' },
        step: { title, category: 'pw:api' },
      })),
    ]

    expect(playbackTests(events)[0].steps.map((step) => step.title)).toEqual([
      'Click',
      'Fill',
      'Press',
      'Select',
      'Check',
      'Expect',
    ])
  })
})

describe('artifactsForPlayback', () => {
  const groups: PlaywrightArtifactGroup[] = [
    {
      testName: 'auth.spec.ts:login',
      artifacts: [
        artifact('screenshot', 'screen.png', 1),
        artifact('screenshot', 'canary-lab-final-page-login.png', 2),
        artifact('trace', 'trace.zip'),
        artifact('video', 'video.webm'),
        artifact('other', 'notes.txt'),
      ],
    },
  ]

  it('uses default policy when no run policy exists', () => {
    expect(artifactsForPlayback('auth.spec.ts:login', groups, undefined)).toEqual({
      screenshotMode: DEFAULT_PLAYWRIGHT_ARTIFACT_POLICY.screenshot,
      screenshots: [artifact('screenshot', 'canary-lab-final-page-login.png', 2)],
      links: [artifact('trace', 'trace.zip')],
    })
  })

  it('hides screenshots and retained links disabled by policy', () => {
    expect(artifactsForPlayback('auth.spec.ts:login', groups, {
      screenshot: 'off',
      video: 'off',
      trace: 'off',
    })).toEqual({
      screenshotMode: 'off',
      screenshots: [],
      links: [],
    })
  })

  it('includes retained video links when policy enables them', () => {
    expect(artifactsForPlayback('auth.spec.ts:login', groups, {
      screenshot: 'on',
      video: 'on-first-retry',
      trace: 'retain-on-failure',
    })).toEqual({
      screenshotMode: 'on',
      screenshots: [artifact('screenshot', 'canary-lab-final-page-login.png', 2)],
      links: [artifact('trace', 'trace.zip'), artifact('video', 'video.webm')],
    })
  })

  it('returns empty artifacts when the test has no artifact group', () => {
    expect(artifactsForPlayback('missing', groups, {
      screenshot: 'on',
      video: 'on',
      trace: 'on',
    })).toEqual({
      screenshotMode: 'on',
      screenshots: [],
      links: [],
    })
  })

  it('falls back to the newest screenshot when no final-page screenshot exists', () => {
    const groupsWithoutFinal: PlaywrightArtifactGroup[] = [
      {
        testName: 'auth.spec.ts:login',
        artifacts: [
          artifact('screenshot', 'older.png'),
          artifact('screenshot', 'newer.png', 3),
        ],
      },
    ]

    expect(artifactsForPlayback('auth.spec.ts:login', groupsWithoutFinal, {
      screenshot: 'only-on-failure',
      video: 'off',
      trace: 'off',
    }).screenshots).toEqual([artifact('screenshot', 'newer.png', 3)])
  })
})

describe('branch helpers', () => {
  const branches: RepoBranchSnapshot[] = [
    repo('/workspace', 'main'),
    repo('/workspace/apps/shop', 'checkout'),
    repo('/other', 'other'),
  ]

  it('selects the closest repo path for a service cwd', () => {
    expect(branchForService(service('/workspace'), branches)).toEqual(repo('/workspace', 'main'))
    expect(branchForService(service('/workspace/apps/shop/web'), branches)).toEqual(repo('/workspace/apps/shop', 'checkout'))
    expect(branchForService(service('/workspace/api'), branches)).toEqual(repo('/workspace', 'main'))
    expect(branchForService(service('/missing'), branches)).toBeNull()
  })

  it('formats branch labels and tooltips', () => {
    expect(branchLabel({ ...repo('/workspace', null), detached: true })).toBe('detached')
    expect(branchLabel(repo('/workspace', null))).toBe('unknown')
    expect(branchLabel(repo('/workspace', 'main'))).toBe('main')

    expect(branchTooltip(service('/workspace/app'), {
      ...repo('/workspace', 'feature/current'),
      expectedBranch: 'main',
      dirty: true,
    })).toBe([
      'repo: repo',
      'branch: feature/current',
      'expected: main',
      'dirty: yes',
      'mismatch: yes',
      'repo path: /workspace',
      'service cwd: /workspace/app',
    ].join('\n'))

    expect(branchTooltip(service('/workspace/app'), repo('/workspace/', 'main'))).toBe([
      'repo: repo',
      'branch: main',
      'repo path: /workspace/',
      'service cwd: /workspace/app',
    ].join('\n'))
  })
})

function artifact(kind: PlaywrightArtifactGroup['artifacts'][number]['kind'], name: string, mtimeMs = 0): PlaywrightArtifactGroup['artifacts'][number] {
  return {
    name,
    kind,
    path: `/tmp/${name}`,
    url: `/artifacts/${name}`,
    sizeBytes: 1,
    mtimeMs,
  }
}

function repo(repoPath: string, branch: string | null): RepoBranchSnapshot {
  return {
    name: 'repo',
    path: repoPath,
    branch,
    detached: false,
    dirty: false,
  }
}

function service(cwd: string): Pick<ServiceManifestEntry, 'cwd'> {
  return { cwd }
}
