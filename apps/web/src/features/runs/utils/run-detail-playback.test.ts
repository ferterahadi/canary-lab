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
