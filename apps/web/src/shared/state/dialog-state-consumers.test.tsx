import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { FeaturesColumn } from '../shell/FeaturesColumn'
import { FlightsPill } from '@/features/flights/components/FlightsPill'
import { useRunsColumn } from '@/features/runs/components/use-runs-column'

vi.mock('../shell/McpPromoContext', () => ({ useMcpPromo: () => ({ gatePromo: vi.fn() }) }))
vi.mock('@/features/runs/state/RunsContext', () => ({ useRuns: () => ({ transients: {}, errors: {} }) }))
vi.mock('./use-live-coverage', () => ({ useLiveCoverageStates: () => ({ value: [] }) }))
vi.mock('@/features/config/components/SettingsModal', () => ({
  SettingsModal: ({ onClose }: { onClose: () => void }) => <button onClick={onClose}>Close fixture settings</button>,
}))

let root: Root
let container: HTMLDivElement
beforeEach(() => { container = document.createElement('div'); document.body.append(container); root = createRoot(container) })
afterEach(() => { act(() => root.unmount()); container.remove() })
function click(selector: string) { act(() => (document.querySelector(selector) as HTMLButtonElement).click()) }

it('keeps Settings controlled until the parent updates its value', () => {
  const change = vi.fn()
  const render = (open: boolean) => act(() => root.render(<FeaturesColumn features={[]} selectedFeature={null} onOpenConfig={() => {}}
    onSelectFeature={() => {}} settingsOpen={open} onSettingsOpenChange={change} />))
  render(false)
  click('button[title="Settings"]')
  expect(change).toHaveBeenLastCalledWith(true)
  expect(container.textContent).not.toContain('Close fixture settings')
  render(true)
  const close = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Close fixture settings')!
  act(() => close.click())
  expect(change).toHaveBeenLastCalledWith(false)
  expect(container.textContent).toContain('Close fixture settings')
  render(false)
  expect(container.textContent).not.toContain('Close fixture settings')
})

it('opens the uncontrolled Settings consumer and closes through its existing callback', () => {
  act(() => root.render(<FeaturesColumn features={[]} selectedFeature={null} onOpenConfig={() => {}} onSelectFeature={() => {}} />))
  click('button[title="Settings"]')
  const close = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Close fixture settings')!
  expect(close).toBeDefined()
  act(() => close.click())
  expect(container.textContent).not.toContain('Close fixture settings')
})

it('routes flight-picker opening and Escape dismissal through the controlled callback', () => {
  const change = vi.fn()
  const render = (open: boolean) => act(() => root.render(<FlightsPill flights={[]} open={open} onOpenChange={change} onOpenFlight={() => {}} />))
  render(false)
  click('button[aria-label="Flights"]')
  expect(change).toHaveBeenLastCalledWith(true)
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  render(true)
  expect(document.querySelector('[role="dialog"]')).not.toBeNull()
  act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  expect(change).toHaveBeenLastCalledWith(false)
  render(false)
  expect(document.querySelector('[role="dialog"]')).toBeNull()
})

it('retains Verify local state and forwards controlled changes in the runs consumer', () => {
  let state: ReturnType<typeof useRunsColumn>
  function Probe({ open, change }: { open?: boolean; change?: (next: boolean) => void }) {
    state = useRunsColumn({ runs: [], selectedRunId: null, onSelectRun: () => {}, verifyOpen: open, onVerifyOpenChange: change })
    return <span>{String(state.verifyDialogOpen)}</span>
  }
  act(() => root.render(<Probe />))
  act(() => state.setVerifyDialogOpen(true))
  expect(container.textContent).toBe('true')
  const change = vi.fn()
  act(() => root.render(<Probe open={false} change={change} />))
  act(() => state.setVerifyDialogOpen(true))
  expect(change).toHaveBeenCalledExactlyOnceWith(true)
  expect(container.textContent).toBe('false')
  act(() => root.render(<Probe open={true} change={change} />))
  act(() => state.setVerifyDialogOpen(false))
  expect(change).toHaveBeenLastCalledWith(false)
  expect(container.textContent).toBe('true')
})
