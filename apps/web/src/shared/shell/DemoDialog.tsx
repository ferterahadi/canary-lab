import { ChevronRightIcon } from '@/shared/ui/atoms'
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
  /** Where to watch — the row this demo acts on, named so a first-time user
   *  knows which line in the Suites column to keep an eye on. Mono, because it
   *  is an identifier they will match against the column by eye. */
  target: { label: string; value: string }
  onStart: () => void
  /** The marked option — carries the view's single accent (the wash + badge,
   *  never a filled button on top of them). */
  recommended?: boolean
  testId: string
}

// The whole card is the action, copying the run-start branch-mismatch dialog's
// `.cl-branch-option` — the app's existing "pick one of these, this one is
// recommended" surface. Reusing it fixes two things a card-with-a-button-inside
// had: the secondary option's full-width outlined button read as disabled, and
// the recommended option stacked three accents (border + label + filled button)
// against the one-accent rule.
function OptionCard({ option }: { option: DemoOption }) {
  return (
    <button
      type="button"
      data-testid={option.testId}
      onClick={option.onStart}
      className={`cl-branch-option ${option.recommended ? 'cl-branch-option-rec' : ''} flex w-full items-start gap-3 rounded px-3 py-2.5 text-left`}
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span className="text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>
            {option.title}
          </span>
          {option.recommended && <span className="cl-badge-accent">Recommended</span>}
          {/* Mono, right-aligned: the cost is the fact the choice turns on, so it
              reads as data rather than as more prose. */}
          <span
            className="ml-auto shrink-0 text-[11px]"
            style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}
          >
            {option.duration}
          </span>
        </div>
        {/* Both bodies are `--text-secondary`: this is supporting copy, and
            `--text-muted` is for metadata. The recommendation is carried by the
            accent wash and the badge — fading the other option's prose would
            make a real choice look half-disabled. */}
        <p className="mt-1.5 text-[12px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
          {option.body}
        </p>
        <div className="mt-2 flex items-baseline gap-1.5 text-[11px]">
          <span style={{ color: 'var(--text-muted)' }}>{option.target.label}</span>
          <span style={{ color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}>
            {option.target.value}
          </span>
        </div>
      </div>
      <ChevronRightIcon />
    </button>
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
      // The suite name is a known constant (SAMPLE_SUITE), so it can be stated.
      target: { label: 'Watch', value: suite },
      onStart: onRunSuite,
      recommended: true,
      testId: 'demo-option-repair',
    })
  }
  if (flightRepoAvailable) {
    options.push({
      title: 'Onboard a repo from nothing',
      duration: '~25 min',
      body: 'A bare repo — no config, no requirements, no tests. Seven stages author a suite for it and name it themselves, so watch for a new row appearing. Run this one when you want to see it against your own code.',
      // The REPO, not a suite name: the flight's plan agent names the suite it
      // authors, so no fixed name can be promised here. Stating one would make
      // the dialog claim something that is only sometimes true.
      target: { label: 'Onboards', value: 'flight-app' },
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
           not a third thing to choose between. Muted so it reads as housekeeping —
           the accent belongs to the recommended card, and a second accented
           control down here would compete with it. `mr-auto` because Modal's
           footer is `justify-end`, which is right for action buttons but wrong for
           a standing setting.
           Unticking takes the pill out of the status bar; the setting is mirrored
           in Settings → Onboarding, so it is never a one-way door. */
        <label className="mr-auto flex cursor-pointer items-center gap-2 text-[11px]" style={{ color: 'var(--text-muted)' }}>
          <input
            type="checkbox"
            data-testid="demo-show-toggle"
            checked={showDemo !== false}
            onChange={(e) => onShowDemoChange(e.target.checked)}
          />
          Show demos in the status bar
        </label>
      )}
    >
      {/* Modal's body wrapper is a bare scroller — every caller supplies its own
          padding. `px-4 py-3` matches `.cl-dialog-header` and the footer, so the
          cards line up with the title above and the checkbox below instead of
          running into the dialog's edges. */}
      <div className="flex flex-col gap-2 px-4 py-3">
        {options.map((option) => <OptionCard key={option.testId} option={option} />)}
      </div>
    </Modal>
  )
}
