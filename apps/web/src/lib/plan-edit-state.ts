import type { PlanStep } from '../api/types'

// Pure helpers for the wizard's Plan Review step. The React glue calls these
// to manipulate an immutable plan; nothing here touches the DOM, the API, or
// React state directly. Keeps the gated module easy to test.

export type Plan = PlanStep[]

export interface ValidationError {
  index: number
  field: 'step'
  message: string
}

export function reorderStep(plan: Plan, fromIndex: number, toIndex: number): Plan {
  if (fromIndex === toIndex) return plan
  if (fromIndex < 0 || fromIndex >= plan.length) return plan
  if (toIndex < 0 || toIndex >= plan.length) return plan
  const next = plan.slice()
  const [moved] = next.splice(fromIndex, 1)
  next.splice(toIndex, 0, moved)
  return next
}

export function removeStep(plan: Plan, index: number): Plan {
  if (index < 0 || index >= plan.length) return plan
  const next = plan.slice()
  next.splice(index, 1)
  return next
}

export function updateStep(
  plan: Plan,
  index: number,
  patch: Partial<PlanStep>,
): Plan {
  if (index < 0 || index >= plan.length) return plan
  const next = plan.slice()
  next[index] = { ...next[index], ...patch }
  return next
}

export function appendStep(plan: Plan): Plan {
  return [...plan, { step: 'New step', actions: [], expectedOutcome: '' }]
}

// Validates the plan. Returns the list of errors — empty list ⇒ valid. The
// only hard rule is "every step's `step` label must be non-empty after trim".
// `actions[]` and `expectedOutcome` may be empty.
export function validatePlan(plan: Plan): ValidationError[] {
  const errs: ValidationError[] = []
  for (let i = 0; i < plan.length; i++) {
    const s = plan[i]
    if (typeof s?.step !== 'string' || s.step.trim().length === 0) {
      errs.push({ index: i, field: 'step', message: 'step label is required' })
    }
  }
  return errs
}

// Convenience: parse a textarea (one action per line) into actions[]. Trims
// trailing whitespace per line and drops fully blank lines.
export function parseActionsTextarea(text: string): string[] {
  return text.split('\n').map((l) => l.trimEnd()).filter((l) => l.length > 0)
}

// Inverse: render actions[] back to a textarea body. Lossless round-trip
// modulo trailing whitespace on lines.
export function renderActionsTextarea(actions: readonly string[]): string {
  return actions.join('\n')
}
