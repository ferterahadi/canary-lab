import { CloseIcon } from '@/shared/ui/atoms'
import type { GuideStep } from '@/shared/state/first-run-guide'

// The first-run guide's card. One component, two steps — see
// `shared/state/first-run-guide.ts` for which step a workspace is on and why.
//
// It renders where its target is, not in a corner: step 1 under the Run button
// it is asking you to press, step 2 under the suite list where the new suite
// will appear. Both are inline cards in the normal column flow, never a floating
// overlay — this is an operator console, and a tooltip layer over it would be a
// different product.

interface StepCopy {
  kicker: string
  title: string
  /** What pressing the button actually does, and what to expect after. */
  body: string[]
  /** Only step 2 carries its own button; step 1's action IS the Run button. */
  action?: string
}

const COPY: Record<GuideStep, StepCopy> = {
  'run-suite': {
    kicker: 'Start here',
    title: 'Press Run to watch a repair',
    body: [
      'This suite is fully set up — services, requirements and tests are all in place. What it is not is passing: ten of its twelve contracts are broken on purpose, one per service.',
      'Run boots the three services, runs the tests itself, and hands each failure to a repair agent. The agent fixes the app and asks for a rerun; Canary Lab decides whether it worked. Expect around ten cycles before it goes green.',
    ],
  },
  'start-flight': {
    kicker: 'Next',
    title: 'Now onboard a repo that has nothing',
    body: [
      'You have seen a finished suite repair itself. The other half of the product is getting to that finished suite in the first place.',
      'flight-app is a second sample repo, shipped bare — no config, no requirements, no tests. A Flight scans it, derives the requirements, authors the suite until coverage is complete, makes its ports injectable, runs, heals, and exports the evaluation report.',
    ],
    action: 'Start a Flight on flight-app',
  },
}

export function FirstRunGuide({
  step,
  onDismiss,
  onAction,
}: {
  step: GuideStep
  onDismiss: () => void
  /** Step 2's launcher. Unused by step 1, whose action is the Run button. */
  onAction?: () => void
}) {
  const copy = COPY[step]
  return (
    <section
      data-testid={`first-run-guide-${step}`}
      className="mx-2 my-2 rounded-md border p-3"
      style={{ borderColor: 'var(--accent)', background: 'var(--accent-soft)' }}
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="cl-kicker" style={{ color: 'var(--accent)' }}>{copy.kicker}</div>
          <h3 className="mt-1 text-xs font-medium" style={{ color: 'var(--text-primary)' }}>{copy.title}</h3>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss this tip"
          title="Dismiss this tip"
          className="cl-icon-button shrink-0"
        >
          <CloseIcon />
        </button>
      </div>
      {copy.body.map((paragraph) => (
        <p key={paragraph.slice(0, 24)} className="mt-2 text-[11px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
          {paragraph}
        </p>
      ))}
      {copy.action && onAction && (
        <button type="button" onClick={onAction} className="cl-button-primary mt-3 w-full justify-center">
          {copy.action}
        </button>
      )}
    </section>
  )
}
