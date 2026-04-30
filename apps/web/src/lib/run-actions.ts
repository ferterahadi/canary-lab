import type { RunStatus } from '../api/types'

export function canPauseHeal(status: RunStatus): boolean {
  return status === 'running'
}

export function canStop(status: RunStatus): boolean {
  return status === 'running' || status === 'healing'
}
