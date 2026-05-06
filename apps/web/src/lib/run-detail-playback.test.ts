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
        steps: [{ title: 'Opened /login', category: 'pw:api', ended: true }],
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

  it('compacts common Playwright step titles and keeps the full browser action trace', () => {
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
        'Fill "98981122" locator(\'#iframeFEOP iframe\').contentFrame().getByRole(\'textbox\', { name: \'Phone Number\' }).first()',
        'Press "Enter"',
        'Select "Singapore"',
        'Check "Terms"',
        'Expect "Success"',
        'page screenshot',
        'Click "Continue"',
        'Expect "Order confirmed"',
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
      'Opened page',
      'Clicked Submit',
      'Entered Email',
      'Entered 98981122 in Phone Number',
      'Pressed Enter',
      'Selected Singapore',
      'Checked Terms',
      'Verified Success',
      'page screenshot',
      'Clicked Continue',
      'Verified Order confirmed',
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
      'Clicked page element',
      'Filled field',
      'Pressed key',
      'Selected option',
      'Checked option',
      'Verified expectation',
    ])
  })

  it('turns Playwright locators into reviewer-readable browser actions', () => {
    const events: PlaywrightPlaybackEvent[] = [
      {
        type: 'test-begin',
        time: '2026-01-01T00:00:00.000Z',
        test: { name: 'localized', title: 'Localized', location: 'localized.spec.ts:1' },
      },
      ...[
        'Fill "" locator(\'#iframeFEOP iframe\').contentFrame().getByRole(\'textbox\', { name: \'Phone Number\' }).first()',
        'Fill "98981122" locator(\'#iframeFEOP iframe\').contentFrame().getByRole(\'textbox\', { name: \'Phone Number\' }).first()',
        'Click locator(\'#iframeFEOP iframe\')',
        'Click locator(\'#iframeFEOP\')',
        'Click getByRole(\'button\', { name: \'Place Order\' })',
        'Click getByLabel(\'Email Address\')',
        'Click getByPlaceholder(\'Search shops\')',
        'Click getByText(\'Apply voucher\')',
        'Click getByTestId(\'checkout-submit\')',
        'Click locator(\'#submit-order\')',
        'Click locator(\'.toast-message\')',
        'Click locator(\'[data-state="open"]\')',
      ].map((title) => ({
        type: 'step-begin' as const,
        time: '2026-01-01T00:00:01.000Z',
        test: { name: 'localized', title: 'Localized' },
        step: { title, category: 'pw:api' },
      })),
    ]

    expect(playbackTests(events)[0].steps.map((step) => step.title)).toEqual([
      'Cleared Phone Number',
      'Entered 98981122 in Phone Number',
      'Clicked embedded login frame',
      'Clicked embedded login frame',
      'Clicked Place Order',
      'Clicked Email Address',
      'Clicked Search shops',
      'Clicked Apply voucher',
      'Clicked checkout-submit control',
      'Clicked submit-order element',
      'Clicked toast-message element',
      'Clicked page element',
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

  it('keeps screenshot ordering stable when mtimes are missing', () => {
    const groupsWithoutMtime: PlaywrightArtifactGroup[] = [
      {
        testName: 'auth.spec.ts:login',
        artifacts: [
          artifact('screenshot', 'first.png', undefined),
          artifact('screenshot', 'second.png', undefined),
        ],
      },
    ]

    expect(artifactsForPlayback('auth.spec.ts:login', groupsWithoutMtime, {
      screenshot: 'on',
      video: 'off',
      trace: 'off',
    }).screenshots).toEqual([artifact('screenshot', 'first.png', undefined)])
  })

  it('prefers the deterministic final-page screenshot over attachment duplicates', () => {
    const groupsWithAttachmentDuplicate: PlaywrightArtifactGroup[] = [
      {
        testName: 'auth.spec.ts:login',
        artifacts: [
          artifact('screenshot', 'canary-lab-final-page-hash.png', 5, 'case/attachments/canary-lab-final-page-hash.png'),
          artifact('screenshot', 'canary-lab-final-page-login.png', 2, 'case/canary-lab-final-page-login.png'),
          artifact('screenshot', 'test-finished-1.png', 6, 'case/test-finished-1.png'),
        ],
      },
    ]

    expect(artifactsForPlayback('auth.spec.ts:login', groupsWithAttachmentDuplicate, {
      screenshot: 'on',
      video: 'off',
      trace: 'off',
    }).screenshots).toEqual([
      artifact('screenshot', 'canary-lab-final-page-login.png', 2, 'case/canary-lab-final-page-login.png'),
    ])
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
    expect(branchForService(service('////'), [repo('/', 'root')])).toEqual(repo('/', 'root'))
    expect(branchForService(service('/workspace/apps/shop/web'), [
      repo('/workspace/apps/shop', 'checkout'),
      repo('/workspace', 'main'),
    ])).toEqual(repo('/workspace/apps/shop', 'checkout'))
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

function artifact(kind: PlaywrightArtifactGroup['artifacts'][number]['kind'], name: string, mtimeMs: number | undefined = 0, artifactPath = `/tmp/${name}`): PlaywrightArtifactGroup['artifacts'][number] {
  return {
    name,
    kind,
    path: artifactPath,
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
