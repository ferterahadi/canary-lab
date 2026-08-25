import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { buildFlightRouteContext } from './flight-route-context'
import type { WorkspaceEvent } from '../../../shared/workspace-events'
import type { FlightManifest } from '../logic/types'
import type { PlanFeaturesTask } from '../../../../../../shared/flights/types'

// `buildFlightRouteContext` is where BOTH flight stores get attached to the
// workspace bus. Nothing else does it: the routes, the MCP tools and the
// conductor all write through these stores precisely so none of them has to
// remember to publish. That makes this the single point where "the UI goes
// stale" is decided for every flight and pre-flight write in the product — and
// the two mappers were the only part of the chain no test drove.
//
// Both bridges coalesce (a driving flight saves on every stage transition), so
// the assertions poll for the flush rather than sleeping a fixed span.

let logsDir: string

beforeEach(() => {
  logsDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-flight-ctx-')))
})

afterEach(() => {
  fs.rmSync(logsDir, { recursive: true, force: true })
})

async function settle(events: WorkspaceEvent[], type: WorkspaceEvent['type']): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    if (events.some((e) => e.type === type)) return
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error(`no ${type} event after the coalesce window; saw ${JSON.stringify(events)}`)
}

function manifest(flightId: string): FlightManifest {
  return {
    flightId,
    feature: 'checkout',
    repoPaths: ['/repo/shop'],
    description: 'd',
    opts: { env: 'local', coverageTarget: 100, yolo: false },
    status: 'running',
    currentStage: 'scout',
    stages: [{ key: 'scout', status: 'running' }],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  } as FlightManifest
}

function planTask(taskId: string): PlanFeaturesTask {
  return {
    taskId,
    repoPaths: ['/repo/shop'],
    description: 'plan the shop',
    status: 'running',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  }
}

describe('buildFlightRouteContext store bridges', () => {
  it('broadcasts flights-changed for a flight written through the context store', async () => {
    const events: WorkspaceEvent[] = []
    const ctx = buildFlightRouteContext({
      featuresDir: path.join(logsDir, 'features'),
      logsDir,
      projectRoot: logsDir,
      adapters: {},
      workspaceEvents: { publish: (e) => events.push(e) },
    })

    ctx.store.save(manifest('fl_1'))
    await settle(events, 'flights-changed')
  })

  it('broadcasts pre-flight-changed for a plan task, distinctly from a flight', async () => {
    const events: WorkspaceEvent[] = []
    const ctx = buildFlightRouteContext({
      featuresDir: path.join(logsDir, 'features'),
      logsDir,
      projectRoot: logsDir,
      adapters: {},
      workspaceEvents: { publish: (e) => events.push(e) },
    })

    ctx.planStore.save(planTask('pf_1'))
    await settle(events, 'pre-flight-changed')
    // The two stores must not share a tag: the Flights pill refetches different
    // lists for each, and collapsing them would leave one of the two stale.
    expect(events.some((e) => e.type === 'flights-changed')).toBe(false)
  })

  it('collapses a burst of flight writes into one refetch nudge', async () => {
    const events: WorkspaceEvent[] = []
    const ctx = buildFlightRouteContext({
      featuresDir: path.join(logsDir, 'features'),
      logsDir,
      projectRoot: logsDir,
      adapters: {},
      workspaceEvents: { publish: (e) => events.push(e) },
    })

    // A driving flight's stage transition looks like this — several saves inside
    // one coalesce window. Every client refetches the whole list per event, so
    // the burst has to arrive as one.
    for (let i = 0; i < 5; i += 1) ctx.store.save(manifest('fl_burst'))
    await settle(events, 'flights-changed')
    expect(events.filter((e) => e.type === 'flights-changed')).toHaveLength(1)
  })

  it('installs no listener at all when the server was wired without a bus', () => {
    const ctx = buildFlightRouteContext({
      featuresDir: path.join(logsDir, 'features'),
      logsDir,
      projectRoot: logsDir,
      adapters: {},
    })
    // The bridge returns before subscribing when there is no publisher, so a
    // save must not throw looking for one.
    expect(() => ctx.store.save(manifest('fl_2'))).not.toThrow()
  })
})
