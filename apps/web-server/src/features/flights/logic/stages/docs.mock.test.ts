import { describe, expect, it, vi } from 'vitest'

// A successful writer that leaves no file behind is a storage-boundary failure:
// the stage must refuse to claim docs evidence until it can observe a readable
// artifact in the feature directory.
vi.mock('../../../config/logic/feature-authoring', () => ({
  writeFeatureDoc: () => ({ ok: true }),
  linkFeatureDoc: () => ({ ok: true }),
}))

import { docsStage } from './docs'
import { stageContextStub } from './__fixtures__/stage-context'
import { FLIGHT_STAGE_KEYS, type FlightManifest } from '../types'

describe('docs stage storage verification', () => {
  it('fails when a reported successful write leaves no readable document behind', async () => {
    const manifest: FlightManifest = {
      flightId: 'fl-docs-write-lost', feature: 'checkout', repoPaths: ['/absent-repo'], description: 'checkout',
      opts: { env: 'local', coverageTarget: 100, yolo: true }, status: 'running', currentStage: 'docs',
      stages: FLIGHT_STAGE_KEYS.map((key) => ({ key, status: 'pending' as const })),
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    }
    const ctx = stageContextStub({
      manifest: () => manifest,
      flightDir: '/tmp/flight-docs-write-lost',
      patchFlight: () => {},
    })
    const outcome = await docsStage({
      featuresDir: '/tmp/flight-docs-write-lost-features', logsDir: '/tmp/flight-docs-write-lost-logs', projectRoot: '/tmp',
      inject: async () => ({ statusCode: 200, json: () => ({}) }),
    }).run(ctx)

    expect(outcome).toEqual({ kind: 'failed', error: 'no docs landed in features/<f>/docs/' })
  })
})
