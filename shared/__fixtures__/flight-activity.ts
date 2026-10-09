import type { FlightStatus } from '../flights/types'

export const flightActivityCases: Array<{ status: FlightStatus; active: boolean }> = [
  { status: 'running', active: true },
  { status: 'waiting-for-approval', active: true },
  { status: 'paused', active: false },
  { status: 'done', active: false },
  { status: 'failed', active: false },
  { status: 'aborted', active: false },
]
