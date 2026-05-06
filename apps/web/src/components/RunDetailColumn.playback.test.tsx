// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { PlaywrightArtifactGroup, PlaywrightArtifactPolicy, PlaywrightPlaybackEvent } from '../api/types'
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
  it('renders the review evidence before collapsed browser actions', () => {
    renderPlayback()

    expect(container.textContent).toContain('passed checkout')
    expect(container.textContent).toContain('Completed without a Playwright error.')
    expect(container.querySelector('img')?.getAttribute('alt')).toBe('Final page screenshot')
    expect(container.querySelector('a[download="trace.zip"]')?.textContent).toBe('Download trace')
    expect(container.textContent).toContain('Browser actions (2)')
    expect(container.textContent).not.toContain('Opened /en_SG')
    expect(container.textContent).not.toContain('Clicked Redeem')
  })

  it('opens retained video inline from an explicit action', () => {
    renderPlayback()

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

    expect(container.textContent).toContain('No screenshots retained for this test')
    expect(container.textContent).toContain('Open video')
    expect(container.textContent).toContain('Download trace')
  })

  it('guides reviewers to enable video when no video artifact is retained', () => {
    renderPlayback({
      artifacts: [
        artifact('screenshot', 'canary-lab-final-page-checkout.png'),
        artifact('trace', 'trace.zip'),
      ],
      policy: { screenshot: 'on', trace: 'on', video: 'off' },
    })

    expect(container.textContent).toContain('Video is disabled.')
    expect(container.textContent).toContain('Feature Configuration > Playwright > Browser & Artifacts > Video')
    expect(container.textContent).toContain('Download trace')
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
}: {
  artifacts?: PlaywrightArtifactGroup['artifacts']
  policy?: PlaywrightArtifactPolicy
  events?: PlaywrightPlaybackEvent[]
} = {}) {
  act(() => {
    root.render(
      <PlaywrightPlayback
        events={playbackEvents}
        artifactGroups={[{ testName: 'checkout', artifacts }]}
        artifactPolicy={policy}
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
