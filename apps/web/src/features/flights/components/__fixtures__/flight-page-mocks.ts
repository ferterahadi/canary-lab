import { useEffect, useState } from 'react'
import { vi } from 'vitest'

// Module factories for the `vi.mock` calls the FlightPage suites share. Each one
// takes the suite's own hoisted `mocks` object and reads it lazily, so a suite
// that re-stubs one of these functions mid-test is still the one answering.
// Never import FlightPage from here: these run while FlightPage's own imports
// are still resolving.

/** `@/shared/api/internal`: the message-first fake the suites throw from their
 *  API stubs. FlightPage.test.tsx builds a status-first one and keeps its own. */
export function apiInternalMock() {
  return {
    ApiError: class ApiError extends Error {
      constructor(message: string, public status = 500, public body: unknown = null) { super(message) }
    },
  }
}

/** `@/features/runs/state/RunsContext`. TestRunPanel reads the run detail and
 *  the run index off the shared runs store; the real provider needs live
 *  sockets, so the two hooks fetch through the suite's `getRunDetail` /
 *  `listRuns` stubs instead. */
export function runsContextMock(mocks: {
  getRunDetail: (runId: string) => Promise<unknown>
  listRuns: (query: object) => Promise<unknown[]>
}) {
  return {
    useRun: (runId?: string | null) => {
      const [detail, setDetail] = useState<unknown>(undefined)
      useEffect(() => {
        let alive = true
        if (runId) mocks.getRunDetail(runId).then((d: unknown) => { if (alive) setDetail(d) }).catch(() => {})
        return () => { alive = false }
      }, [runId])
      return { detail, status: undefined, transient: null, displayStatus: undefined, error: null }
    },
    useRuns: () => {
      const [runs, setRuns] = useState<unknown[]>([])
      useEffect(() => {
        let alive = true
        mocks.listRuns({}).then((r: unknown[]) => { if (alive) setRuns(r) }).catch(() => {})
        return () => { alive = false }
      }, [])
      return {
        runs,
        connection: 'live',
        transients: {},
        errors: {},
        refresh: vi.fn(),
        startRun: vi.fn(),
        startVerification: vi.fn(),
        abort: vi.fn(),
        delete: vi.fn(),
        pauseHeal: vi.fn(),
        cancelHeal: vi.fn(),
        clearError: vi.fn(),
      }
    },
  }
}
