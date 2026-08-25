import { describe, it, expect } from 'vitest'

import type { FastifyReply, FastifyRequest } from 'fastify'

import type { FlightManifest, FlightStatus } from '../logic/types'

import { MCP_ORIGIN_HEADER, isExternallyDriven, rejectForeignFlightDecision } from './flight-decision-origin'

function manifest(
  status: FlightStatus,
  stageProducer?: 'internal' | 'external',
): FlightManifest {
  return {
    flightId: 'fl_x',
    feature: 'checkout',
    repoPaths: ['/repo'],
    description: 'checkout flow',
    opts: { env: 'local', yolo: false, ...(stageProducer ? { stageProducer } : {}) },
    status,
    currentStage: 'docs',
    stages: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  } as FlightManifest
}

/** Minimal stand-ins — the guard only reads one header and only writes a code. */
function callers(headers: Record<string, string> = {}) {
  let code: number | null = null
  const req = { headers } as unknown as FastifyRequest
  const reply = { code: (c: number) => { code = c; return reply } } as unknown as FastifyReply
  return { req, reply, codeSent: () => code }
}

describe('isExternallyDriven', () => {
  it.each<FlightStatus>(['running', 'waiting-for-approval', 'paused'])(
    'is true for an external flight that is still %s',
    (status) => {
      expect(isExternallyDriven(manifest(status, 'external'))).toBe(true)
    },
  )

  // Once the flight settles there is no client left to defer to, so the record
  // is the UI's again — Fly again, Continue from a step, delete.
  it.each<FlightStatus>(['done', 'failed', 'aborted'])('is false once the flight is %s', (status) => {
    expect(isExternallyDriven(manifest(status, 'external'))).toBe(false)
  })

  it('is false for an internal flight, and for one that never declared a producer', () => {
    expect(isExternallyDriven(manifest('running', 'internal'))).toBe(false)
    expect(isExternallyDriven(manifest('running'))).toBe(false)
  })
})

describe('rejectForeignFlightDecision', () => {
  it('refuses a browser call on a live externally driven flight', () => {
    const { req, reply, codeSent } = callers()
    const refusal = rejectForeignFlightDecision(req, reply, () => manifest('running', 'external'))
    expect(refusal).toMatchObject({ type: 'flight_externally_driven' })
    expect(refusal?.error).toContain('driven by the agent that started it')
    expect(refusal?.error).toContain('Request takeover')
    expect(codeSent()).toBe(409)
  })

  // The whole point of the header: MCP and the web UI post to the same routes,
  // so the guard must let the flight's own driver through.
  it('lets the MCP client through on the same flight', () => {
    const { req, reply, codeSent } = callers({ [MCP_ORIGIN_HEADER]: 'mcp' })
    expect(rejectForeignFlightDecision(req, reply, () => manifest('running', 'external'))).toBeNull()
    expect(codeSent()).toBeNull()
  })

  it('lets the browser through on an internal flight and on a settled external one', () => {
    const { req, reply } = callers()
    expect(rejectForeignFlightDecision(req, reply, () => manifest('running', 'internal'))).toBeNull()
    expect(rejectForeignFlightDecision(req, reply, () => manifest('done', 'external'))).toBeNull()
  })

  // A flight we cannot read is not a flight we can prove belongs to an agent —
  // the handler behind the guard already answers both cases correctly (404 for
  // missing, 409 for a broken store), and a guard that threw would turn those
  // into a 500.
  it('declines rather than blocking when the flight is missing or the lookup throws', () => {
    const { req, reply, codeSent } = callers()
    expect(rejectForeignFlightDecision(req, reply, () => null)).toBeNull()
    expect(rejectForeignFlightDecision(req, reply, () => { throw new Error('boom') })).toBeNull()
    expect(codeSent()).toBeNull()
  })
})
