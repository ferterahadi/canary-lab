import { describe, expect, it } from 'vitest'

import type {
  PlaywrightArtifactGroup,
  PlaywrightPlaybackEvent,
  RepoBranchSnapshot,
  ServiceManifestEntry,
} from '@/shared/api/types'

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
        location: 'auth.spec.ts:1',
        startedAt: '2026-01-01T00:00:00.000Z',
        endedAt: '2026-01-01T00:00:04.000Z',
        status: 'passed',
        passed: true,
        durationMs: 40,
        retry: 1,
        error: undefined,
        steps: [{ title: 'Opened /login', category: 'pw:api', ended: true }],
      },
    ])
  })

  it('collapses rerun attempts to a single entry showing the latest attempt', () => {
    const events: PlaywrightPlaybackEvent[] = [
      {
        type: 'test-begin',
        time: '2026-01-01T00:00:00.000Z',
        test: { name: 'checkout', title: 'checkout flow', location: 'checkout.spec.ts:1' },
      },
      {
        type: 'test-end',
        time: '2026-01-01T00:00:05.000Z',
        test: { name: 'checkout', title: 'checkout flow', location: 'checkout.spec.ts:1' },
        status: 'failed',
        passed: false,
        durationMs: 5000,
        retry: 0,
        error: { message: 'first failure' },
      },
      {
        type: 'test-begin',
        time: '2026-01-01T00:10:00.000Z',
        test: { name: 'checkout', title: 'checkout flow rerun', location: 'checkout.spec.ts:1' },
      },
      {
        type: 'step-begin',
        time: '2026-01-01T00:10:01.000Z',
        test: { name: 'checkout', title: 'checkout flow rerun' },
        step: { title: 'Click "Place Order"', category: 'pw:api' },
      },
    ]

    expect(playbackTests(events)).toEqual([
      expect.objectContaining({
        name: 'checkout',
        title: 'checkout flow rerun',
        startedAt: '2026-01-01T00:10:00.000Z',
        steps: [{ title: 'Clicked Place Order', category: 'pw:api', ended: false }],
      }),
    ])
  })

  it('collapses heal-cycle reruns whose line number shifted within the same spec file', () => {
    // A heal edit moved the test from line 205 to 222 between the failed
    // attempt and the passing rerun — same test, one entry, latest attempt.
    const events: PlaywrightPlaybackEvent[] = [
      {
        type: 'test-begin',
        time: '2026-01-01T00:00:00.000Z',
        test: { name: 'cleanup', title: 'survives final cleanup', location: 'cleanup-race.spec.ts:205' },
      },
      {
        type: 'test-end',
        time: '2026-01-01T00:00:06.000Z',
        test: { name: 'cleanup', title: 'survives final cleanup', location: 'cleanup-race.spec.ts:205' },
        status: 'failed',
        passed: false,
        durationMs: 6000,
        retry: 0,
        error: { message: 'Condition was not met within 6000ms' },
      },
      {
        type: 'test-begin',
        time: '2026-01-01T00:02:00.000Z',
        test: { name: 'cleanup', title: 'survives final cleanup', location: 'cleanup-race.spec.ts:222' },
      },
      {
        type: 'test-end',
        time: '2026-01-01T00:02:49.000Z',
        test: { name: 'cleanup', title: 'survives final cleanup', location: 'cleanup-race.spec.ts:222' },
        status: 'passed',
        passed: true,
        durationMs: 49000,
        retry: 0,
      },
    ]

    expect(playbackTests(events)).toEqual([
      expect.objectContaining({
        name: 'cleanup',
        status: 'passed',
        passed: true,
        location: 'cleanup-race.spec.ts:222',
      }),
    ])
  })

  it('keeps same-titled tests in different spec files as separate entries', () => {
    const events: PlaywrightPlaybackEvent[] = [
      {
        type: 'test-begin',
        time: '2026-01-01T00:00:00.000Z',
        test: { name: 'health', title: 'gateway is healthy', location: 'api.spec.ts:10' },
      },
      {
        type: 'test-end',
        time: '2026-01-01T00:00:02.000Z',
        test: { name: 'health', title: 'gateway is healthy', location: 'api.spec.ts:10' },
        status: 'passed',
        passed: true,
        durationMs: 2000,
        retry: 0,
      },
      {
        type: 'test-begin',
        time: '2026-01-01T00:00:03.000Z',
        test: { name: 'health', title: 'gateway is healthy', location: 'worker.spec.ts:10' },
      },
      {
        type: 'test-end',
        time: '2026-01-01T00:00:05.000Z',
        test: { name: 'health', title: 'gateway is healthy', location: 'worker.spec.ts:10' },
        status: 'passed',
        passed: true,
        durationMs: 2000,
        retry: 0,
      },
    ]

    expect(playbackTests(events)).toEqual([
      expect.objectContaining({ location: 'api.spec.ts:10' }),
      expect.objectContaining({ location: 'worker.spec.ts:10' }),
    ])
  })

  it('uses the test name as the playback identity when location is missing', () => {
    const events: PlaywrightPlaybackEvent[] = [
      {
        type: 'test-begin',
        time: '2026-01-01T00:00:00.000Z',
        test: { name: 'legacy checkout', title: 'legacy checkout', location: '' },
      },
      {
        type: 'test-end',
        time: '2026-01-01T00:00:03.000Z',
        test: { name: 'legacy checkout', title: 'legacy checkout', location: '' },
        status: 'passed',
        passed: true,
        durationMs: 3000,
        retry: 0,
      },
    ]

    expect(playbackTests(events)).toEqual([
      expect.objectContaining({
        name: 'legacy checkout',
        title: 'legacy checkout',
        endedAt: '2026-01-01T00:00:03.000Z',
      }),
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
        location: 'setup.spec.ts:1',
        status: 'failed',
        passed: false,
        durationMs: 20,
        endedAt: '2026-01-01T00:00:02.000Z',
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

// Every case below was taken from the real playback corpus (32,575 step events
// across 79 recorded runs), not invented — the previous compactor rendered a
// column of identical `Verified toBe` rows for the API suites because it read
// Playwright's matcher name as the assertion's target.
describe('playback step compaction against real Playwright step titles', () => {
  const step = (title: string, category: string): PlaywrightPlaybackEvent => ({
    type: 'step-begin',
    time: '2026-01-01T00:00:01.000Z',
    test: { name: 'api', title: 'API' },
    step: { title, category },
  })
  const around = (...steps: PlaywrightPlaybackEvent[]): PlaywrightPlaybackEvent[] => [
    { type: 'test-begin', time: '2026-01-01T00:00:00.000Z', test: { name: 'api', title: 'API', location: 'api.spec.ts:1' } },
    ...steps,
  ]
  const titles = (events: PlaywrightPlaybackEvent[]): string[] =>
    playbackTests(events)[0].steps.map((s) => s.title)

  it('tallies matcher-only assertions instead of repeating them verbatim', () => {
    expect(titles(around(
      step('Expect "toBe"', 'expect'),
      step('Expect "toBeTruthy"', 'expect'),
      step('Expect "toBe"', 'expect'),
    ))).toEqual(['Verified 3 assertions'])
  })

  it('treats space-separated negation as the same matcher-only shape', () => {
    expect(titles(around(step('Expect "not toBeNaN"', 'expect')))).toEqual(['Verified 1 assertion'])
  })

  it('keeps the assertion when the matcher names a target, in reading order', () => {
    expect(titles(around(
      step('Expect "toBe"', 'expect'),
      step(`Expect "toBeVisible" getByRole('button', { name: /^authorize$/i })`, 'expect'),
      step('Expect "toBe"', 'expect'),
    ))).toEqual(['Verified 1 assertion', 'Verified authorize is visible', 'Verified 1 assertion'])
  })

  it('reads regex-literal locator names, which are as common as quoted ones', () => {
    expect(titles(around(
      step('Expect "toBeVisible" getByText(/token created/i)', 'expect'),
      step(`Click getByRole('button', { name: /login|sign in/i })`, 'pw:api'),
    ))).toEqual(['Verified token created is visible', 'Clicked login / sign in'])
  })

  it('surfaces API requests, which are the whole trace for a non-browser suite', () => {
    expect(titles(around(
      step('Create request context', 'pw:api'),
      step('POST "/oauth/token"', 'pw:api'),
      step('GET "/api/queues/%2f"', 'pw:api'),
    ))).toEqual(['POST /oauth/token', 'GET /api/queues/%2f'])
  })

  it("passes an author's own assertion message through untouched", () => {
    expect(titles(around(step('auth probe should return a userId', 'expect'))))
      .toEqual(['auth probe should return a userId'])
  })

  it('never renders a negated assertion as its positive', () => {
    // The pane is evidence: reporting `not toBeVisible` as "is visible" states
    // the opposite of what the test asserted.
    expect(titles(around(
      step(`Expect "not toBeVisible" getByRole('button', { name: 'Deny' })`, 'expect'),
      step(`Expect "not toHaveText" getByText('Welcome')`, 'expect'),
      step(`Expect "not toBeFrobnicated" getByLabel('Widget')`, 'expect'),
    ))).toEqual([
      'Verified Deny is not visible',
      'Verified Welcome does not have the expected text',
      'Verified Widget does not match toBeFrobnicated',
    ])
  })

  it('does not let a matcher name be read as an action verb', () => {
    // `toBeChecked` contains "check" and `toBeSelected` contains "select" — the
    // verb branches used to claim them and report an assertion as a click.
    expect(titles(around(
      step(`Expect "toBeChecked" getByLabel('Terms')`, 'expect'),
      step(`Expect "toBeVisible" getByLabel('Terms')`, 'expect'),
    ))).toEqual(['Verified Terms is checked', 'Verified Terms is visible'])
  })

  it('does not invent words out of regex character classes', () => {
    // `/^Pickup\\s/` matches a button labelled "Pickup"; stripping the backslash
    // rendered "Pickups", a string that appears neither in the test nor the UI.
    expect(titles(around(
      step(`Click getByRole('button', { name: /^Pickup\\s/ })`, 'pw:api'),
      step(`Click getByRole('button', { name: /Hi,\\s+\\S+/ })`, 'pw:api'),
      step(`Click getByRole('button', { name: /^allow\\b/i })`, 'pw:api'),
      step(`Click getByText(/example\\.com/)`, 'pw:api'),
    ))).toEqual(['Clicked Pickup', 'Clicked Hi', 'Clicked allow', 'Clicked example.com'])
  })

  it('holds a tally open while any assertion under it is still running', () => {
    const events = around(
      step('Expect "toBe"', 'expect'),
      step('Expect "toBe"', 'expect'),
    )
    events.push({
      type: 'step-end',
      time: '2026-01-01T00:00:02.000Z',
      test: { name: 'api', title: 'API' },
      step: { title: 'Expect "toBe"', category: 'expect' },
    })
    const [tally] = playbackTests(events)[0].steps
    expect(tally.title).toBe('Verified 2 assertions')
    expect(tally.ended).toBe(false)
  })

  it('drops attachment bookkeeping', () => {
    expect(titles(around(
      step('Attach "canary-lab-final-page"', 'test.attach'),
      step('POST "/api/login"', 'pw:api'),
    ))).toEqual(['POST /api/login'])
  })
})

describe('branchForService', () => {
  const repo = { name: 'mighty-cns', path: '/Users/me/Documents/mighty-cns', branch: 'main', dirty: false, detached: false }

  it('matches a service running in a per-run worktree by repo name', () => {
    // The isolated-run default: cwd is under `logs/runs/<id>/worktrees/<repo>`,
    // nowhere near the repo snapshot's own path — path containment found nothing
    // and the ref silently disappeared from every isolated run.
    const service = {
      cwd: '/Users/me/Documents/canary-lab-workspace/logs/runs/2026-07-01T0245-o456/worktrees/mighty-cns',
      repoName: 'mighty-cns',
    }
    expect(branchForService(service, [repo])).toBe(repo)
  })

  it('still falls back to the deepest containing path when no repo name is recorded', () => {
    const nested = { name: 'inner', path: '/Users/me/Documents/mighty-cns/packages/inner', branch: 'dev', dirty: false, detached: false }
    const service = { cwd: '/Users/me/Documents/mighty-cns/packages/inner/src' }
    expect(branchForService(service, [repo, nested])).toBe(nested)
  })

  it('returns null when the named repo is absent rather than guessing by path', () => {
    expect(branchForService({ cwd: '/tmp/elsewhere', repoName: 'unknown-repo' }, [repo])).toBeNull()
  })
})
