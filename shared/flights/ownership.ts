import type { FlightStatus } from './types'

/** Paused external flights retain their decision owner even after releasing the repo lock. */
export function isExternallyDriven(
  flight: { status: FlightStatus; opts?: { stageProducer?: 'internal' | 'external' }; stageProducer?: 'internal' | 'external' } | null | undefined,
): boolean {
  if (!flight) return false
  const producer = flight.opts?.stageProducer ?? flight.stageProducer
  return producer === 'external' && (flight.status === 'running' || flight.status === 'waiting-for-approval' || flight.status === 'paused')
}
