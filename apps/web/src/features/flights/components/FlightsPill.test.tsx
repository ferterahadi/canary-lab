// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FlightIndexEntry, FlightStageStatus, PlanFeaturesTask } from '@/shared/api/client'
import { FLIGHT_STAGE_KEYS } from '@shared/flights/types'
import type { FeatureActivity } from '../state/feature-activity'
import { FlightsPill, featureActivityRows, featureChipState, groupPickerRows, resolveFeatureFlightAction } from './FlightsPill'
import { ACTIVITY_CHIP, RUNNING_STAGE_CHIP } from './FlightChipState'

const preFlight = (over: Partial<PlanFeaturesTask>): PlanFeaturesTask => ({
  taskId: 'fp_1',
  repoPaths: ['/repo/shop'],
  description: 'test the checkout flow end to end',
  status: 'running',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  ...over,
})

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

const flight = (over: Partial<FlightIndexEntry>): FlightIndexEntry => ({
  id: 'fl_1',
  createdAt: '2026-01-01T00:00:00Z',
  flightId: 'fl_1',
  feature: 'checkout',
  repoPaths: ['/repo/shop'],
  status: 'running',
  currentStage: 'scout',
  stages: FLIGHT_STAGE_KEYS.map((key) => ({ key, status: 'pending' as const })),
  updatedAt: '2026-01-01T00:00:00Z',
  ...over,
})

function render(flights: FlightIndexEntry[], onOpenFlight = vi.fn()) {
  act(() => { root.render(<FlightsPill flights={flights} onOpenFlight={onOpenFlight} />) })
  return onOpenFlight
}

describe('FlightsPill', () => {
  it('stays visible when idle and shows the active count while flights run', () => {
    render([])
    expect(container.textContent).toContain('Flights')
    render([flight({}), flight({ flightId: 'fl_2', id: 'fl_2', feature: 'billing' })])
    expect(container.textContent).toContain('Flights · 2 active')
    expect(container.querySelector('[data-testid="flights-pill-count"]')?.textContent).toBe('2')
  })

  it('flags a parked checkpoint as the state that needs the human', () => {
    render([flight({ status: 'waiting-for-approval' })])
    expect(container.textContent).toContain('approval needed')
  })

  it('opens the picker (worst-first) and picking a flight opens the routed view', () => {
    const onOpen = render([
      flight({ flightId: 'fl_done', id: 'fl_done', feature: 'done-f', status: 'done' }),
      flight({ flightId: 'fl_wait', id: 'fl_wait', feature: 'wait-f', status: 'waiting-for-approval' }),
    ])
    act(() => { container.querySelector<HTMLButtonElement>('[data-testid="flights-pill"] button')?.click() })
    const menu = document.body.querySelector('[data-testid="flights-task-menu"]')
    expect(menu).toBeTruthy()
    // Worst-first: the flight needing approval lists above the done one.
    const rows = [...menu!.querySelectorAll('[data-testid^="flight-open-"]')]
    expect(rows[0]?.getAttribute('data-testid')).toBe('flight-open-fl_wait')
    act(() => { (rows[0] as HTMLButtonElement).click() })
    expect(onOpen).toHaveBeenCalledWith('fl_wait')
  })

  it('offers the flight command as the empty state (never dead-end)', () => {
    render([])
    act(() => { container.querySelector<HTMLButtonElement>('[data-testid="flights-pill"] button')?.click() })
    expect(document.body.querySelector('[data-testid="flights-task-menu"]')?.textContent).toContain('npx canary-lab flight')
  })

  it('surfaces a backgrounded pre-flight as its own row and reopens it on click', () => {
    const onOpenPreFlight = vi.fn()
    act(() => {
      root.render(
        <FlightsPill
          flights={[]}
          preFlights={[preFlight({ taskId: 'fp_9', status: 'running' })]}
          onOpenFlight={vi.fn()}
          onOpenPreFlight={onOpenPreFlight}
        />,
      )
    })
    // A running pre-flight counts as active on the trigger.
    expect(container.textContent).toContain('Flights · 1 active')
    act(() => { container.querySelector<HTMLButtonElement>('[data-testid="flights-pill"] button')?.click() })
    const row = document.body.querySelector<HTMLButtonElement>('[data-testid="pre-flight-open-fp_9"]')
    expect(row).toBeTruthy()
    expect(row?.textContent).toContain('test the checkout flow')
    expect(row?.textContent).toContain('planning')
    act(() => { row!.click() })
    expect(onOpenPreFlight).toHaveBeenCalledWith('fp_9')
  })

  it('a settled pre-flight reads "to review" and flags the pill for attention', () => {
    act(() => {
      root.render(
        <FlightsPill
          flights={[]}
          preFlights={[preFlight({ taskId: 'fp_done', status: 'done' })]}
          onOpenFlight={vi.fn()}
          onOpenPreFlight={vi.fn()}
        />,
      )
    })
    expect(container.textContent).toContain('approval needed')
    act(() => { container.querySelector<HTMLButtonElement>('[data-testid="flights-pill"] button')?.click() })
    const row = document.body.querySelector<HTMLButtonElement>('[data-testid="pre-flight-open-fp_done"]')
    expect(row?.textContent).toContain('to review')
  })

  it('renders one mini-rail cell per USER-VISIBLE stage (plumbing hidden, pairs merged)', () => {
    render([flight({})])
    act(() => { container.querySelector<HTMLButtonElement>('[data-testid="flights-pill"] button')?.click() })
    const rail = document.body.querySelector('[data-testid="stage-mini-rail"]')
    // similarity hidden; run+heal, scaffold+env-capture, docs+prd-summary merged (R21/R22/R32/R33).
    expect(rail?.children.length).toBe(FLIGHT_STAGE_KEYS.length - 4)
  })

  // R26 — the pill is the one live indicator for the absorbed surfaces.

  it('lights up from activity alone (a standalone run, zero flights)', () => {
    const activity = new Map<string, FeatureActivity>([['checkout', { kind: 'running', runId: 'r1' }]])
    act(() => { root.render(<FlightsPill flights={[]} activity={activity} onOpenFlight={vi.fn()} />) })
    expect(container.textContent).toContain('Flights · 1 active')
    expect(container.querySelector('[data-testid="flights-pill-count"]')?.textContent).toBe('1')
  })

  it('dedupes a flight and its own stage job to one active feature', () => {
    const activity = new Map<string, FeatureActivity>([['checkout', { kind: 'portifying', workflowId: 'wf1' }]])
    act(() => { root.render(<FlightsPill flights={[flight({})]} activity={activity} onOpenFlight={vi.fn()} />) })
    expect(container.textContent).toContain('Flights · 1 active')
  })

  it("the feature's chip narrates the live activity verb over the flight status", () => {
    const activity = new Map<string, FeatureActivity>([['checkout', { kind: 'authoring', draftId: 'd1' }]])
    act(() => { root.render(<FlightsPill flights={[flight({ status: 'done' })]} activity={activity} onOpenFlight={vi.fn()} />) })
    act(() => { container.querySelector<HTMLButtonElement>('[data-testid="flights-pill"] button')?.click() })
    expect(document.body.querySelector('[data-testid="flight-status-chip"]')?.textContent).toBe('Authoring')
  })

  it('a healing run reads "Healing" in amber, not the flight\'s generic "running"', () => {
    const activity = new Map<string, FeatureActivity>([['checkout', { kind: 'healing', runId: 'r1' }]])
    act(() => { root.render(<FlightsPill flights={[flight({ status: 'running', currentStage: 'run' })]} activity={activity} onOpenFlight={vi.fn()} />) })
    act(() => { container.querySelector<HTMLButtonElement>('[data-testid="flights-pill"] button')?.click() })
    const chip = document.body.querySelector<HTMLElement>('[data-testid="flight-status-chip"]')
    expect(chip?.textContent).toBe('Healing')
    // Amber, matching the run detail header and the suites column's healing wash —
    // the same state must not read sky here and amber there.
    expect(chip?.style.color).toContain('var(--warning)')
    // Live, so it can't be mistaken for the at-rest amber states ("to approve").
    expect(featureChipState(flight({ status: 'running' }), { kind: 'healing', runId: 'r1' }).live).toBe(true)
  })

  it('with no activity the chip shows the LAST state (done / failed / aborted)', () => {
    act(() => { root.render(<FlightsPill flights={[flight({ status: 'failed' })]} onOpenFlight={vi.fn()} />) })
    act(() => { container.querySelector<HTMLButtonElement>('[data-testid="flights-pill"] button')?.click() })
    expect(document.body.querySelector('[data-testid="flight-status-chip"]')?.textContent).toBe('Failed')
  })

  it('a parked checkpoint outranks live activity (the human is the blocker)', () => {
    const chip = featureChipState(
      { status: 'waiting-for-approval', currentStage: 'portify' },
      { kind: 'portifying', workflowId: 'wf1' },
    )
    expect(chip.label).toBe('to approve')
    expect(chip.rank).toBe(0)
  })

  it('activity on a feature with no flight gets a row (progress chip, no "no flight" label) that opens it', () => {
    const onOpenActivity = vi.fn()
    const activity = new Map<string, FeatureActivity>([['pay', { kind: 'portifying', workflowId: 'wf9' }]])
    act(() => { root.render(<FlightsPill flights={[flight({})]} activity={activity} onOpenFlight={vi.fn()} onOpenActivity={onOpenActivity} />) })
    act(() => { container.querySelector<HTMLButtonElement>('[data-testid="flights-pill"] button')?.click() })
    const row = document.body.querySelector<HTMLButtonElement>('[data-testid="activity-open-pay"]')
    expect(row).toBeTruthy()
    // R39: no "no flight" text — the live progress chip carries the state.
    expect(row?.textContent).not.toContain('no flight')
    expect(row?.querySelector('[data-testid="flight-status-chip"]')?.textContent).toBe('Portifying')
    // R56: a synthesized mini rail shows WHERE in the pipeline the live job
    // sits — the mapped stage (portify) renders in the sky "running" tone,
    // every other stage stays pending (grey). No fake 'done' squares.
    const rail = row?.querySelector('[data-testid="stage-mini-rail"]')
    expect(rail).toBeTruthy()
    const portifyCell = rail?.querySelector('[data-testid="stage-mini-cell-portify"]') as HTMLElement | null
    expect(portifyCell?.style.background).toContain('var(--running)') // running tone (sky)
    act(() => { row?.click() })
    expect(onOpenActivity).toHaveBeenCalledWith('pay', { kind: 'portifying', workflowId: 'wf9' })
  })

  it('live rows sort above resting flights (worst-first)', () => {
    const activity = new Map<string, FeatureActivity>([['live-f', { kind: 'running', runId: 'r1' }]])
    act(() => {
      root.render(
        <FlightsPill
          flights={[
            flight({ flightId: 'fl_done', id: 'fl_done', feature: 'done-f', status: 'done' }),
            flight({ flightId: 'fl_live', id: 'fl_live', feature: 'live-f', status: 'done' }),
          ]}
          activity={activity}
          onOpenFlight={vi.fn()}
        />,
      )
    })
    act(() => { container.querySelector<HTMLButtonElement>('[data-testid="flights-pill"] button')?.click() })
    const rows = [...document.body.querySelectorAll('[data-testid^="flight-open-"]')]
    // The done flight whose feature is running again floats above the resting one.
    expect(rows[0]?.getAttribute('data-testid')).toBe('flight-open-fl_live')
  })
})

describe('FlightsPill — every feature 1:1 (R49)', () => {
  it('lists never-flown features as greyed-rail rows that open the flight launcher', () => {
    const onStartFlight = vi.fn()
    act(() => {
      root.render(
        <FlightsPill
          flights={[flight({ status: 'done', currentStage: null })]}
          features={[{ name: 'checkout' }, { name: 'menu-management' }]}
          onOpenFlight={vi.fn()}
          onStartFlight={onStartFlight}
        />,
      )
    })
    act(() => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Flights"]')!.click()
    })
    const row = document.body.querySelector<HTMLButtonElement>('[data-testid="not-flown-menu-management"]')
    expect(row).toBeTruthy()
    // Same anatomy as a flight row: greyed mini rail squares + the chip (never a dash).
    expect(row!.querySelector('[data-testid="stage-mini-rail"]')).toBeTruthy()
    expect(row!.querySelector('[data-testid="flight-status-chip"]')?.textContent).toBe('Not flown')
    act(() => { row!.click() })
    expect(onStartFlight).toHaveBeenCalledWith('menu-management')
  })

  it('a flightless feature with evidence-derived progress reads "idle" with its completed squares lit', () => {
    const stages = [
      { key: 'similarity', status: 'done' }, { key: 'scout', status: 'done' },
      { key: 'scaffold', status: 'done' }, { key: 'env-capture', status: 'done' },
      { key: 'docs', status: 'pending' }, { key: 'prd-summary', status: 'pending' },
      { key: 'specs-coverage', status: 'pending' }, { key: 'portify', status: 'pending' },
      { key: 'run', status: 'done' }, { key: 'heal', status: 'done' },
      { key: 'evaluation-export', status: 'pending' },
    ] as const
    act(() => {
      root.render(
        <FlightsPill
          flights={[]}
          features={[{ name: 'todo-api', stages: [...stages] }]}
          onOpenFlight={vi.fn()}
          onStartFlight={vi.fn()}
        />,
      )
    })
    act(() => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Flights"]')!.click()
    })
    // R81: evidence-derived progress IS flight progress, so the row is a
    // flight-detail link (`derived-open-…`), not the start-from-scratch row.
    const row = document.body.querySelector<HTMLButtonElement>('[data-testid="derived-open-todo-api"]')
    expect(row).toBeTruthy()
    // Nothing is running and the pipeline isn't finished → "idle"; the rail
    // (not the chip) carries the progress story.
    expect(row!.querySelector('[data-testid="flight-status-chip"]')?.textContent).toBe('Idle')
    const railCell = (key: string) => row!.querySelector(`[data-testid="stage-mini-cell-${key}"]`) as HTMLElement | null
    expect(railCell('scaffold')?.style.background).toContain('var(--success)') // Suite setup done (green)
    expect(railCell('run')?.style.background).toContain('var(--success)') // latest run green
    expect(railCell('specs-coverage')?.style.background).toContain('var(--border-default)') // no artifact → pending
  })

  // R81 — the reported bug: a fully-built suite with no flight record opened the
  // start-from-scratch dialog, asking the user to redo finished work.
  it('a flightless feature with EVERY stage done reads "done" and opens its derived flight', () => {
    const stages = FLIGHT_STAGE_KEYS.map((key) => ({ key, status: 'done' as const }))
    const onOpenFlight = vi.fn()
    const onStartFlight = vi.fn()
    act(() => {
      root.render(
        <FlightsPill
          flights={[]}
          features={[{ name: 'go-smoke', stages }]}
          onOpenFlight={onOpenFlight}
          onStartFlight={onStartFlight}
        />,
      )
    })
    act(() => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Flights"]')!.click()
    })
    const row = document.body.querySelector<HTMLButtonElement>('[data-testid="derived-open-go-smoke"]')
    expect(row).toBeTruthy()
    expect(row!.querySelector('[data-testid="flight-status-chip"]')?.textContent).toBe('Done')
    act(() => { row!.click() })
    // Routes to the flight view under the derived token — never the launcher.
    expect(onOpenFlight).toHaveBeenCalledWith('feature:go-smoke')
    expect(onStartFlight).not.toHaveBeenCalled()
  })

  it('an untouched feature still opens the launcher — with nothing to show, starting IS the next action', () => {
    const onOpenFlight = vi.fn()
    const onStartFlight = vi.fn()
    act(() => {
      root.render(
        <FlightsPill
          flights={[]}
          features={[{ name: 'bare', stages: FLIGHT_STAGE_KEYS.map((key) => ({ key, status: 'pending' as const })) }]}
          onOpenFlight={onOpenFlight}
          onStartFlight={onStartFlight}
        />,
      )
    })
    act(() => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Flights"]')!.click()
    })
    const row = document.body.querySelector<HTMLButtonElement>('[data-testid="not-flown-bare"]')
    expect(row).toBeTruthy()
    act(() => { row!.click() })
    expect(onStartFlight).toHaveBeenCalledWith('bare')
    expect(onOpenFlight).not.toHaveBeenCalled()
  })

  it('idle ranks above not flown, and the chip splits on evidence', () => {
    const lit = [{ key: 'scout', status: 'done' }] as Array<{ key: 'scout'; status: 'done' }>
    expect(featureChipState(null, undefined, lit).label).toBe('idle')
    expect(featureChipState(null, undefined, [{ key: 'scout', status: 'pending' }]).label).toBe('not flown')
    expect(featureChipState(null, undefined, undefined).label).toBe('not flown')
    expect(featureChipState(null, undefined, lit).rank).toBeLessThan(featureChipState(null).rank)
    // A partial rail never reads "done" just because every square it happens to
    // carry is lit — "done" means the whole pipeline.
    expect(featureChipState(null, undefined, FLIGHT_STAGE_KEYS.map((key) => ({ key, status: 'done' as const }))).label).toBe('done')
  })

  it('a running flight names the stage it is on, not a flat "running"', () => {
    // The early stages matter most: a flight spends its first minutes here, and
    // these were the ones that used to report nothing.
    expect(featureChipState({ status: 'running', currentStage: 'scout', pauseReason: undefined }).label).toBe('scanning')
    expect(featureChipState({ status: 'running', currentStage: 'scaffold', pauseReason: undefined }).label).toBe('setting up')
    expect(featureChipState({ status: 'running', currentStage: 'prd-summary', pauseReason: undefined }).label).toBe('distilling')
    expect(featureChipState({ status: 'running', currentStage: 'specs-coverage', pauseReason: undefined }).label).toBe('authoring')
    expect(featureChipState({ status: 'running', currentStage: 'run', pauseReason: undefined }).label).toBe('running')
    // The only bare "running" left: launched, no stage recorded yet.
    expect(featureChipState({ status: 'running', currentStage: null, pauseReason: undefined }).label).toBe('running')
  })

  it('reuses the standalone activity verb for the stages that overlap it', () => {
    // A portify started by a flight stage and one started on its own must read
    // the same — the colour and the word both mean the same thing everywhere.
    for (const stage of ['portify', 'heal', 'evaluation-export'] as const) {
      const viaStage = featureChipState({ status: 'running', currentStage: stage, pauseReason: undefined }).label
      const viaActivity = ACTIVITY_CHIP[stage === 'portify' ? 'portifying' : stage === 'heal' ? 'healing' : 'exporting'].label
      expect(viaStage).toBe(viaActivity)
    }
  })

  it('keeps every stage verb inside the chip\'s fixed width', () => {
    // The chip is pinned at 72px; "portifying" / "to approve" (10 chars) are the
    // widest labels it is designed around, so no verb may exceed that.
    for (const verb of Object.values(RUNNING_STAGE_CHIP)) {
      expect(verb.length).toBeLessThanOrEqual(10)
    }
  })

  it('an activity-only row keeps its evidence squares lit under the running overlay', () => {
    const activity = new Map<string, FeatureActivity>([['pay', { kind: 'portifying', workflowId: 'wf9' }]])
    act(() => {
      root.render(
        <FlightsPill
          flights={[]}
          activity={activity}
          features={[{ name: 'pay', stages: [{ key: 'scout', status: 'done' }, { key: 'scaffold', status: 'done' }, { key: 'env-capture', status: 'done' }] }]}
          onOpenFlight={vi.fn()}
          onOpenActivity={vi.fn()}
        />,
      )
    })
    act(() => { container.querySelector<HTMLButtonElement>('[data-testid="flights-pill"] button')?.click() })
    const row = document.body.querySelector<HTMLButtonElement>('[data-testid="activity-open-pay"]')
    const cell = (key: string) => row?.querySelector(`[data-testid="stage-mini-cell-${key}"]`) as HTMLElement | null
    expect(cell('portify')?.style.background).toContain('var(--running)') // live job (sky)
    expect(cell('scaffold')?.style.background).toContain('var(--success)') // evidence stays lit (green)
  })

  it('never duplicates a feature that already has a flight row, and not-flown rows sink to the bottom', () => {
    act(() => {
      root.render(
        <FlightsPill
          flights={[flight({ feature: 'checkout', status: 'waiting-for-approval' })]}
          features={[{ name: 'checkout' }, { name: 'aaa-never-flown' }]}
          onOpenFlight={vi.fn()}
          onStartFlight={vi.fn()}
        />,
      )
    })
    act(() => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Flights"]')!.click()
    })
    const rows = [...document.body.querySelectorAll('[data-testid^="flight-open-"], [data-testid^="not-flown-"]')]
    expect(rows).toHaveLength(2)
    expect(rows[0]?.getAttribute('data-testid')).toBe('flight-open-fl_1')
    expect(rows[1]?.getAttribute('data-testid')).toBe('not-flown-aaa-never-flown')
    // A never-flown feature does not light the pill.
    expect(container.querySelector('[data-testid="flights-pill-count"]')).toBeTruthy() // the waiting flight does
  })
})

describe('groupPickerRows group fallback (R69)', () => {
  it('groups a pre-scaffold flight by its own group when the feature list has none', () => {
    // First-Flight batch: the flight carries `group`, but the feature isn't in
    // the workspace features list yet (its config.cjs is unscaffolded).
    const rows = featureActivityRows(
      [
        flight({ flightId: 'a', id: 'a', feature: 'login', group: 'Auth', status: 'paused' }),
        flight({ flightId: 'b', id: 'b', feature: 'signup', group: 'Auth', status: 'running' }),
      ],
      new Map(),
      [], // no workspace features yet
    )
    const { ungrouped, groups } = groupPickerRows(rows, [])
    expect(ungrouped).toEqual([])
    expect(groups).toHaveLength(1)
    expect(groups[0].group).toBe('Auth')
    expect(groups[0].rows.map((r) => r.feature).sort()).toEqual(['login', 'signup'])
  })

  it('prefers the workspace feature group over the flight group when both exist', () => {
    const rows = featureActivityRows(
      [flight({ feature: 'checkout', group: 'StaleFlightGroup', status: 'running' })],
      new Map(),
      [{ name: 'checkout', group: 'Shop' }],
    )
    const { groups } = groupPickerRows(rows, [{ name: 'checkout', group: 'Shop' }])
    expect(groups.map((g) => g.group)).toEqual(['Shop'])
  })
})

describe('resolveFeatureFlightAction — the Features column row shortcut', () => {
  const allPending = FLIGHT_STAGE_KEYS.map((key) => ({ key, status: 'pending' as const }))
  const worked = FLIGHT_STAGE_KEYS.map((key) => ({ key, status: key === 'scout' ? 'done' as const : 'pending' as const }))

  it('points at the recorded flight and reports its state', () => {
    const action = resolveFeatureFlightAction(
      'checkout',
      [flight({ flightId: 'fl_9', feature: 'checkout', status: 'waiting-for-approval' })],
    )
    expect(action).toEqual({
      flightId: 'fl_9',
      tone: 'var(--warning)',
      label: 'to approve',
      title: 'needs approval',
      // Parked on a checkpoint: nothing is executing, but the row still earns the
      // heavier "blocked on you" wash in the suites column.
      live: false,
      attention: true,
    })
  })

  it('reports a running flight as live but not attention-seeking', () => {
    const action = resolveFeatureFlightAction(
      'checkout',
      [flight({ flightId: 'fl_9', feature: 'checkout', status: 'running' })],
    )
    expect(action?.live).toBe(true)
    expect(action?.attention).toBe(false)
  })

  it('leaves a settled flight uncued — no wash for a suite that already flew', () => {
    const action = resolveFeatureFlightAction(
      'checkout',
      [flight({ flightId: 'fl_9', feature: 'checkout', status: 'done' })],
    )
    expect(action?.live).toBe(false)
    expect(action?.attention).toBe(false)
  })

  it('keeps the first record when a feature has several flights (same rule as the picker rows)', () => {
    const action = resolveFeatureFlightAction('checkout', [
      flight({ flightId: 'fl_new', feature: 'checkout', status: 'running' }),
      flight({ flightId: 'fl_old', feature: 'checkout', status: 'done' }),
    ])
    expect(action?.flightId).toBe('fl_new')
  })

  it('points a flightless-but-worked suite at its derived flight token', () => {
    const action = resolveFeatureFlightAction('checkout', [], undefined, worked)
    expect(action?.flightId).toBe('feature:checkout')
    expect(action?.label).toBe('idle')
  })

  it('lets live activity carry the tone even without a flight record', () => {
    const action = resolveFeatureFlightAction(
      'checkout',
      [],
      { kind: 'running', runId: 'r1' },
      worked,
    )
    expect(action?.flightId).toBe('feature:checkout')
    expect(action?.tone).toBe('var(--running)')
  })

  it('carries the healing verb and its amber tone into the suites-column shortcut', () => {
    const action = resolveFeatureFlightAction(
      'checkout',
      [flight({ flightId: 'fl_9', feature: 'checkout', status: 'running', currentStage: 'run' })],
      { kind: 'healing', runId: 'r1' },
    )
    expect(action?.label).toBe('healing')
    expect(action?.tone).toBe('var(--warning)')
    // Busy, not blocked: the row keeps the live wash and no attention treatment.
    expect(action?.live).toBe(true)
    expect(action?.attention).toBe(false)
  })

  it('offers nothing for a suite with no flight and no evidence — starting stays with "+ New" (R40)', () => {
    expect(resolveFeatureFlightAction('fresh', [], undefined, allPending)).toBeNull()
    // Older server: no evidence block at all → no derived rail, no shortcut.
    expect(resolveFeatureFlightAction('fresh', [])).toBeNull()
    // Another feature's flight must not resolve for this one.
    expect(resolveFeatureFlightAction('fresh', [flight({ feature: 'checkout' })])).toBeNull()
  })
})

describe('external-work hand-off (a step running in the user\'s own agent)', () => {
  const handOff = (over: Partial<FlightIndexEntry> = {}) => flight({
    status: 'waiting-for-approval',
    checkpointKind: 'external-work',
    currentStage: 'scout',
    stages: FLIGHT_STAGE_KEYS.map((key) => ({
      key,
      status: (key === 'scout' ? 'waiting-for-approval' : 'pending') as FlightStageStatus,
    })),
    ...over,
  })

  it('reads as the running stage verb, live and ranked with running work — not "to approve"', () => {
    const chip = featureChipState(handOff())
    expect(chip.label).toBe('scanning')
    expect(chip.tone).toBe('var(--running)')
    expect(chip.live).toBe(true)
    expect(chip.rank).toBe(1)
    // The chip is 72px wide, so the phrase lives in the tooltip.
    expect(chip.title).toBe('Scanning in your agent')
  })

  it('falls back to a bare "running" when no stage is recorded yet', () => {
    const chip = featureChipState(handOff({ currentStage: null }))
    expect(chip.label).toBe('running')
    expect(chip.title).toBe('Running in your agent')
  })

  it('still says "to approve" for a real question wearing the same status', () => {
    expect(featureChipState(handOff({ checkpointKind: 'missing-env' })).label).toBe('to approve')
  })

  it('keeps the pill neutral-active: counted, but never "approval needed"', () => {
    render([handOff()])
    expect(container.textContent).toContain('Flights · 1 active')
    expect(container.textContent).not.toContain('approval needed')
  })

  it('a real checkpoint alongside it still turns the pill amber', () => {
    render([handOff(), flight({ id: 'fl_2', flightId: 'fl_2', feature: 'billing', status: 'waiting-for-approval', checkpointKind: 'missing-env' })])
    expect(container.textContent).toContain('approval needed')
  })

  it('paints the parked cell of the mini rail as running, matching its chip', () => {
    act(() => { root.render(<FlightsPill flights={[handOff()]} onOpenFlight={vi.fn()} />) })
    act(() => { container.querySelector<HTMLButtonElement>('[data-testid="flights-pill"] button')?.click() })
    const cell = document.body.querySelector<HTMLElement>('[data-testid="stage-mini-cell-scout"]')
    expect(cell?.style.background).toBe('var(--running)')
  })

  it('gives the suites-column shortcut the live wash, not the blocked-on-you one', () => {
    const action = resolveFeatureFlightAction('checkout', [handOff()])
    expect(action?.live).toBe(true)
    expect(action?.attention).toBe(false)
    // A genuine question on the same status keeps the attention treatment.
    expect(resolveFeatureFlightAction('checkout', [handOff({ checkpointKind: 'portify-apply' })])?.attention).toBe(true)
  })
})
