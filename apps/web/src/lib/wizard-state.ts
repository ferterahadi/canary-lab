// Pure state-machine helpers for the Add Test wizard. The backend's draft
// status is the source of truth — these helpers map a draft status to the
// wizard step the user should be looking at, decide whether the wizard can
// advance, and tell the polling loop when to stop.
//
// All functions are pure: same inputs → same outputs, no I/O.

export type DraftStatus =
  | 'created'
  | 'recommending'
  | 'planning'
  | 'plan-ready'
  | 'generating'
  | 'spec-ready'
  | 'accepted'
  | 'rejected'
  | 'error'

export type WizardStep = 'configure' | 'plan' | 'spec' | 'done'

// Map a draft status to the wizard step the user should be on. When the
// status is in a transient state we keep them on the step that owns that
// transition (planning → plan, generating → spec).
export function nextStepForStatus(status: DraftStatus): WizardStep {
  switch (status) {
    case 'created':
    case 'recommending':
      return 'configure'
    case 'planning':
    case 'plan-ready':
      return 'plan'
    case 'generating':
    case 'spec-ready':
      return 'spec'
    case 'accepted':
      return 'done'
    case 'rejected':
    case 'error':
      // Stay on whatever step we were on; caller decides whether to bail.
      return 'configure'
  }
}

// Statuses that mean the current step has settled — the user can act, and
// polling should stop. `error` is included so the UI surfaces the message
// instead of spinning forever.
const TERMINAL_BY_STEP: Record<WizardStep, DraftStatus[]> = {
  configure: ['created', 'plan-ready', 'spec-ready', 'accepted', 'rejected', 'error'],
  plan: ['plan-ready', 'spec-ready', 'accepted', 'rejected', 'error'],
  spec: ['spec-ready', 'accepted', 'rejected', 'error'],
  done: ['accepted', 'rejected', 'error'],
}

export function terminalForStep(step: WizardStep, status: DraftStatus): boolean {
  return TERMINAL_BY_STEP[step].includes(status)
}

// True when the wizard is *waiting on the backend* for the current step —
// poll while this is true, stop when it flips false.
export function isPollingForStep(step: WizardStep, status: DraftStatus): boolean {
  if (step === 'plan') return status === 'planning'
  if (step === 'spec') return status === 'generating'
  if (step === 'configure') return status === 'recommending'
  return false
}

export function canAdvance(status: DraftStatus, currentStep: WizardStep): boolean {
  if (currentStep === 'configure') return status === 'created'
  if (currentStep === 'plan') return status === 'plan-ready'
  if (currentStep === 'spec') return status === 'spec-ready'
  return false
}

export function isTerminalDraft(status: DraftStatus): boolean {
  return status === 'accepted' || status === 'rejected' || status === 'error'
}
