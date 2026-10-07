import type { SabotageLevel } from '../../../../../../shared/benchmark-index'

export function normalizeSabotageLevel(value: unknown): SabotageLevel {
  return value === 'min' || value === 'max' ? value : 'med'
}
