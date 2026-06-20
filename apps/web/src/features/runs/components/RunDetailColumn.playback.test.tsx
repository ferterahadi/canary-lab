// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PlaywrightArtifactGroup, PlaywrightArtifactPolicy, PlaywrightPlaybackEvent, RunSummary } from '../../../api/types'
import { PlaywrightPlayback } from './RunDetailColumn'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
})

describe('PlaywrightPlayback', () => {
  it('renders trace in the card header and keeps evidence collapsed', () => {
    renderPlayback()

    expect(container.textContent).toContain('passed checkout')
    expect(container.textContent).toContain('Completed without a Playwright error.')
    expect(container.querySelector('a[download="trace.zip"]')?.textContent).toBe('Download trace')
    expect(container.querySelector('.cl-card')?.firstElementChild?.querySelector('a[download="trace.zip"]')?.textContent).toBe('Download trace')
    expect(container.querySelector('a[download="trace.zip"]')?.className).toContain('truncate')
    expect(container.querySelector('a[download="trace.zip"]')?.className).toContain('max-w-full')
    expect(container.textContent).toContain('Screenshot')
    expect(container.textContent).toContain('Video')
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).not.toContain('Open video')
    expect(container.textContent).toContain('Browser actions (2)')
    expect(container.textContent).not.toContain('Opened /en_SG')
    expect(container.textContent).not.toContain('Clicked Redeem')
  })

  it('expands retained screenshots only when requested', () => {
    renderPlayback()

    const button = [...container.querySelectorAll('button')]
      .find((candidate) => candidate.textContent?.includes('Screenshot'))
    expect(button).toBeTruthy()

    act(() => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(container.querySelector('img')?.getAttribute('alt')).toBe('Final page screenshot')
  })

  it('opens retained video inline from an explicit action', () => {
    renderPlayback()

    const videoSection = [...container.querySelectorAll('button')]
      .find((candidate) => candidate.textContent?.includes('Video'))
    expect(videoSection).toBeTruthy()

    act(() => {
      videoSection?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    const button = [...container.querySelectorAll('button')]
      .find((candidate) => candidate.textContent === 'Open video')
    expect(button).toBeTruthy()

    act(() => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(container.querySelector('video')?.getAttribute('src')).toBe('/artifacts/video.webm')
    expect(button?.textContent).toBe('Hide video')
  })

  it('expands browser actions only when requested', () => {
    renderPlayback()

    const button = [...container.querySelectorAll('button')]
      .find((candidate) => candidate.textContent?.includes('Browser actions'))
    expect(button).toBeTruthy()

    act(() => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(container.textContent).toContain('Opened /en_SG')
    expect(container.textContent).toContain('Clicked Redeem')
  })

  it('keeps browser actions after the eighth step in the collapsed trace count and expanded list', () => {
    renderPlayback({ events: manyActionEvents })

    expect(container.textContent).toContain('Browser actions (10)')
    expect(container.textContent).not.toContain('Clicked Continue')
    expect(container.textContent).not.toContain('Verified Order confirmed')

    const button = [...container.querySelectorAll('button')]
      .find((candidate) => candidate.textContent?.includes('Browser actions'))
    expect(button).toBeTruthy()

    act(() => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(container.textContent).toContain('Clicked Continue')
    expect(container.textContent).toContain('Verified Order confirmed')
  })

  it('keeps artifact actions visible when no screenshot is retained', () => {
    renderPlayback({
      artifacts: [
        artifact('trace', 'trace.zip'),
        artifact('video', 'video.webm'),
      ],
    })

    expect(container.textContent).toContain('No screenshot retained')
    expect(container.textContent).toContain('Download trace')
    expect(container.textContent).not.toContain('Open video')
  })

  it('renders skipped playback status in amber instead of failed red', () => {
    renderPlayback({
      events: events.map((event) => event.type === 'test-end'
        ? { ...event, status: 'skipped', passed: false }
        : event),
    })

    const skippedPill = [...container.querySelectorAll('span')]
      .find((candidate) => candidate.textContent === 'skipped')
    expect(skippedPill).toBeTruthy()
    expect(skippedPill?.className).toContain('amber')
    expect(skippedPill?.className).not.toContain('rose')
  })

  it('uses short artifact guidance and opens Playwright settings', () => {
    const onOpenArtifactSettings = vi.fn()
    renderPlayback({
      artifacts: [
        artifact('screenshot', 'canary-lab-final-page-checkout.png'),
        artifact('trace', 'trace.zip'),
      ],
      policy: { screenshot: 'on', trace: 'on', video: 'off' },
      onOpenArtifactSettings,
    })

    expect(container.textContent).toContain('Video')
    expect(container.textContent).toContain('Disabled')
    expect(container.textContent).not.toContain('Feature Configuration > Playwright > Browser & Artifacts > Video')
    expect(container.textContent).toContain('Download trace')

    const settingsButton = [...container.querySelectorAll('button')]
      .find((candidate) => candidate.textContent === 'Settings')
    expect(settingsButton).toBeTruthy()

    act(() => {
      settingsButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(onOpenArtifactSettings).toHaveBeenCalledTimes(1)
  })

  it('marks the currently running rerun attempt with the chip instead of a card highlight', () => {
    renderPlayback({
      events: [
        {
          type: 'test-begin',
          time: '2026-01-01T00:00:00.000Z',
          test: { name: 'checkout', title: 'checkout failed before heal', location: 'checkout.spec.ts:1' },
        },
        {
          type: 'test-end',
          time: '2026-01-01T00:01:00.000Z',
          test: { name: 'checkout', title: 'checkout failed before heal', location: 'checkout.spec.ts:1' },
          status: 'failed',
          passed: false,
          durationMs: 60000,
          retry: 0,
          error: { message: 'old failure' },
        },
        {
          type: 'test-begin',
          time: '2026-01-01T00:10:00.000Z',
          test: { name: 'checkout', title: 'checkout rerun now', location: 'checkout.spec.ts:1' },
        },
      ],
      summary: {
        complete: false,
        total: 2,
        passed: 0,
        failed: [{ name: 'checkout', error: { message: 'old failure' } }],
        running: { name: 'checkout', location: 'checkout.spec.ts:1' },
      },
    })

    expect(container.textContent).not.toContain('checkout failed before heal')
    expect(container.textContent).not.toContain('old failure')
    expect(container.textContent).toContain('checkout rerun now')
    expect(container.textContent).not.toContain('Now running:')
    expect(container.textContent).toContain('Currently executing in this Playwright process.')
    expect(container.textContent).toContain('1/1')
    const runningPill = [...container.querySelectorAll('span')]
      .find((candidate) => candidate.textContent === 'running')
    expect(runningPill).toBeTruthy()
    const cards = [...container.querySelectorAll('.cl-card.p-3')]
    expect(cards).toHaveLength(1)
    expect(cards[0]?.getAttribute('style') ?? '').not.toMatch(/background|box-shadow/)
  })
})

function renderPlayback({
  artifacts = [
    artifact('screenshot', 'canary-lab-final-page-checkout.png'),
    artifact('trace', 'trace.zip'),
    artifact('video', 'video.webm'),
  ],
  policy = { screenshot: 'on', trace: 'on', video: 'on' },
  events: playbackEvents = events,
  onOpenArtifactSettings,
  summary,
}: {
  artifacts?: PlaywrightArtifactGroup['artifacts']
  policy?: PlaywrightArtifactPolicy
  events?: PlaywrightPlaybackEvent[]
  onOpenArtifactSettings?: () => void
  summary?: RunSummary
} = {}) {
  act(() => {
    root.render(
      <PlaywrightPlayback
        events={playbackEvents}
        artifactGroups={[{ testName: 'checkout', artifacts }]}
        artifactPolicy={policy}
        onOpenArtifactSettings={onOpenArtifactSettings}
        summary={summary}
      />,
    )
  })
}

const events: PlaywrightPlaybackEvent[] = [
  {
    type: 'test-begin',
    time: '2026-01-01T00:00:00.000Z',
    test: { name: 'checkout', title: 'passed checkout', location: 'checkout.spec.ts:1' },
  },
  {
    type: 'step-begin',
    time: '2026-01-01T00:00:01.000Z',
    test: { name: 'checkout', title: 'passed checkout' },
    step: { title: 'Navigate to "/en_SG"', category: 'pw:api' },
  },
  {
    type: 'step-end',
    time: '2026-01-01T00:00:02.000Z',
    test: { name: 'checkout', title: 'passed checkout' },
    step: { title: 'Navigate to "/en_SG"', category: 'pw:api' },
  },
  {
    type: 'step-begin',
    time: '2026-01-01T00:00:03.000Z',
    test: { name: 'checkout', title: 'passed checkout' },
    step: { title: 'Click "Redeem"', category: 'pw:api' },
  },
  {
    type: 'step-end',
    time: '2026-01-01T00:00:04.000Z',
    test: { name: 'checkout', title: 'passed checkout' },
    step: { title: 'Click "Redeem"', category: 'pw:api' },
  },
  {
    type: 'test-end',
    time: '2026-01-01T00:00:05.000Z',
    test: { name: 'checkout', title: 'passed checkout', location: 'checkout.spec.ts:1' },
    status: 'passed',
    passed: true,
    durationMs: 40000,
    retry: 0,
  },
]

const manyActionEvents: PlaywrightPlaybackEvent[] = [
  {
    type: 'test-begin',
    time: '2026-01-01T00:00:00.000Z',
    test: { name: 'checkout', title: 'passed checkout', location: 'checkout.spec.ts:1' },
  },
  ...[
    'Navigate to "/en_SG"',
    'Click "Redeem"',
    'Fill "Email"',
    'Fill "98981122" locator(\'#iframeFEOP iframe\').contentFrame().getByRole(\'textbox\', { name: \'Phone Number\' }).first()',
    'Press "Enter"',
    'Select "Singapore"',
    'Check "Terms"',
    'Expect "Success"',
    'Click "Continue"',
    'Expect "Order confirmed"',
  ].map((title) => ({
    type: 'step-begin' as const,
    time: '2026-01-01T00:00:01.000Z',
    test: { name: 'checkout', title: 'passed checkout' },
    step: { title, category: 'pw:api' },
  })),
  {
    type: 'test-end',
    time: '2026-01-01T00:00:05.000Z',
    test: { name: 'checkout', title: 'passed checkout', location: 'checkout.spec.ts:1' },
    status: 'passed',
    passed: true,
    durationMs: 40000,
    retry: 0,
  },
]

function artifact(kind: PlaywrightArtifactGroup['artifacts'][number]['kind'], name: string): PlaywrightArtifactGroup['artifacts'][number] {
  return {
    name,
    kind,
    path: name,
    url: `/artifacts/${name}`,
    sizeBytes: 1,
    mtimeMs: 1,
  }
}
