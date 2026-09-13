// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FlightManifest } from '@/shared/api/client'
import { CheckpointControls } from './CheckpointControls'
import { isElicitationReview } from '@/shared/lib/workspace-view-state'

const respond = vi.hoisted(() => vi.fn(async () => ({})))
vi.mock('@/shared/api/client', () => ({ respondFlightCheckpoint: respond }))
vi.mock('@/features/evaluation', () => ({ useEvaluationExports: () => ({}) }))
afterEach(() => { window.history.replaceState(null, '', '/'); vi.clearAllMocks() })

describe('human input invited by MCP URL elicitation', () => {
  it('keeps ordinary external controls locked and sends the invitation only for the matching checkpoint', async () => {
    const checkpoint = { kind: 'missing-env' as const, message: 'Provide environment values', options: ['retry'] }
    const flight = { flightId: 'fl1', feature: 'checkout', status: 'waiting-for-approval', opts: { stageProducer: 'external' } } as FlightManifest
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    const render = () => act(async () => root.render(<CheckpointControls flightId="fl1" flight={flight} checkpoint={checkpoint} onResponded={() => {}} />))
    try {
      await render()
      expect(container.querySelector<HTMLTextAreaElement>('textarea')?.disabled).toBe(true)
      window.history.replaceState(null, '', '/?view=flights&flight=fl1&elicitation=fl1%3Amissing-env&inputToken=invitation')
      await render()
      expect(container.querySelector<HTMLTextAreaElement>('textarea')?.disabled).toBe(false)
      await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="checkpoint-choice-retry"]')!.click())
      expect(respond).toHaveBeenCalledWith('fl1', { choice: 'retry', elicitationToken: 'invitation' })
      expect(isElicitationReview('another', 'missing-env')).toBe(false)
      expect(isElicitationReview('fl1', 'external-work')).toBe(false)
    } finally {
      await act(async () => root.unmount())
      container.remove()
    }
  })
})
