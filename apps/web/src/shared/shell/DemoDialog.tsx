import { Modal } from '@/shared/ui/Overlays'

// The demo chooser — which of the two shipped samples to try.
//
// It replaces a pair of inline cards that appeared in sequence: press Run on the
// worked suite, and only once that went green, an offer to fly the bare repo.
// Sequencing them meant the Flight half — the product's headline command — was
// invisible until someone had sat through a ten-cycle repair. Both are offered
// here at once.
//
// Two rules the copy follows:
//
//   • RECOMMEND, don't fork. Two equal-weight options is the same failure as two
//     equal-weight cards: the reader has to work out which one to spend their
//     time on. The repair demo is marked, and the cost of picking wrong is
//     lopsided — someone who starts the 25-minute flight first watches a repo
//     scan before anything visible happens.
//   • SAY WHAT TO WATCH FOR. The agent reporting a fix that the harness then
//     rejects is the whole product; a viewer who hasn't been told that reads ten
//     cycles as churn. That sentence is why the repair option earns the accent.

interface DemoOption {
  title: string
  /** Rough wall-clock, so the choice is honest about what it costs. */
  duration: string
  body: string
  action: string
  onStart: () => void
  /** The marked option — carries the view's single accent. */
  recommended?: boolean
  testId: string
}

function OptionBlock({ option }: { option: DemoOption }) {
  return (
    <section
      data-testid={option.testId}
      className="rounded-md border p-3"
      style={{ borderColor: option.recommended ? 'var(--accent)' : 'var(--border-default)' }}
    >
      <div className="flex items-baseline gap-2">
        <h3 className="text-xs font-medium" style={{ color: 'var(--text-primary)' }}>{option.title}</h3>
        {option.recommended && (
          <span className="text-[11px]" style={{ color: 'var(--accent)' }}>recommended</span>
        )}
        <span className="ml-auto shrink-0 text-[11px]" style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
          {option.duration}
        </span>
      </div>
      <p className="mt-1.5 text-[11px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
        {option.body}
      </p>
      <button
        type="button"
        onClick={option.onStart}
        className={`${option.recommended ? 'cl-button-primary' : 'cl-button'} mt-2.5 w-full justify-center`}
      >
        {option.action}
      </button>
    </section>
  )
}

export function DemoDialog({
  open,
  onClose,
  suite,
  flightRepoAvailable,
  onRunSuite,
  onStartFlight,
  showDemo,
  onShowDemoChange,
}: {
  open: boolean
  onClose: () => void
  /** The shipped worked suite, or null once it has been deleted — the repair
   *  option is dropped rather than offered as a button that can't work. */
  suite: string | null
  /** Whether the bare sample repo is still on disk, under the same rule. */
  flightRepoAvailable: boolean
  onRunSuite: () => void
  onStartFlight: () => void
  /** Current `showDemo` from canary-lab.config.json (null while loading). */
  showDemo: boolean | null
  onShowDemoChange: (next: boolean) => void
}) {
  const options: DemoOption[] = []
  if (suite) {
    options.push({
      title: 'Repair a broken suite',
      duration: '~4 min',
      body: 'Ten of twelve contracts are broken on purpose. The agent will report each one fixed — watch the harness rerun the tests and disagree.',
      action: 'Run the suite',
      onStart: onRunSuite,
      recommended: true,
      testId: 'demo-option-repair',
    })
  }
  if (flightRepoAvailable) {
    options.push({
      title: 'Onboard a repo from nothing',
      duration: '~25 min',
      body: 'A bare repo — no config, no requirements, no tests. Seven stages author the suite for it. Run this one when you want to see it against your own code.',
      action: 'Start a flight',
      onStart: onStartFlight,
      // Recommended only when it is the only option left: the marker means "spend
      // your time here", and on a lone option there is no comparison to draw.
      testId: 'demo-option-flight',
    })
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      eyebrow="Getting started"
      title="See how this works"
      description="Both routes end in an evaluation report — that's the deliverable, not the green tick."
      width={430}
      testId="demo-dialog"
      footer={(
        /* In the footer rather than the body: it is a setting about this dialog,
           not a third thing to choose between. Unticking it takes the pill out of
           the status bar — the setting is mirrored in Settings → General, so
           turning the demos off is never a one-way door. */
        <label className="flex cursor-pointer items-center gap-2">
          <input
            type="checkbox"
            data-testid="demo-show-toggle"
            checked={showDemo !== false}
            onChange={(e) => onShowDemoChange(e.target.checked)}
          />
          <span className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>
            Show demos in the status bar
          </span>
        </label>
      )}
    >
      <div className="flex flex-col gap-2">
        {options.map((option) => <OptionBlock key={option.testId} option={option} />)}
      </div>
    </Modal>
  )
}
