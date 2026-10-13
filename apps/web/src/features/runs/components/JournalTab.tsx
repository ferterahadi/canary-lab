import { formatLocalDateTime } from '@/shared/lib/format'
import { useState } from 'react'
import { useRunJournal } from '../state/use-run-journal'
import type { JournalSection } from '@shared/run-detail'
import { EmptyGlyph, EmptyState } from '@/shared/ui/EmptyState'
import { EMPTY_COPY } from '@/shared/ui/empty-state-copy'
import { SourceModal } from '@/shared/ui/ActivityLogModal'
import { Frame } from './RunPane'
import {
  classifyOutcome,
  outcomeBadgeClass,
  outcomeLabel,
  parseBodyFields,
  presentJournalFields,
} from '../utils/journal-utils'

interface Props {
  feature: string
  runId: string
  refreshKey?: number
  /** Repair cycles this run went through. Zero means the journal is empty
   *  because nothing needed repairing — a different fact from "the agent ran
   *  and wrote nothing", and the empty state says which. */
  healCycles?: number
  /** False when embedded in a pane that already owns the frame and scroller. */
  framed?: boolean
}

export function JournalTab({ feature, runId, refreshKey = 0, healCycles = 0, framed = true }: Props) {
  const { value: entries, error } = useRunJournal(feature, runId, refreshKey)
  const occurrences = new Map<string, number>()

  return (
    <Frame framed={framed}>
      {error && (
        <div className="mb-3 rounded-md border border-danger/40 bg-danger/10 p-2 text-xs text-danger">
          Failed to load journal: {error}
        </div>
      )}
      {!entries ? (
        <EmptyState {...EMPTY_COPY.journalLoading} icon={EmptyGlyph.journal} />
      ) : entries.length === 0 ? (
        <EmptyState {...(healCycles > 0 ? EMPTY_COPY.journalNoEntries : EMPTY_COPY.journalPassed)} />
      ) : (
        <ul className="space-y-3">
          {entries.map((entry) => {
            // Newer iterations must not remount existing cards or their dialogs.
            const identity = JSON.stringify([runId, entry.iteration, entry.timestamp])
            const occurrence = occurrences.get(identity) ?? 0
            occurrences.set(identity, occurrence + 1)
            return <EntryCard key={`${identity}:${occurrence}`} entry={entry} />
          })}
        </ul>
      )}
    </Frame>
  )
}

/**
 * One repair cycle.
 *
 * A cycle is a short story — what the agent thought was wrong, what it changed,
 * and whether that worked — so the hypothesis is the card's headline instead of
 * the first row of a four-row key/value table with the code's own field names
 * down the left. The card has the run-detail anatomy: a title strip with the
 * outcome chip, the body, and a footer whose one action opens the raw markdown
 * in a modal — read in full, at full width, without pushing the card around.
 */
function EntryCard({ entry }: { entry: JournalSection }) {
  const [rawOpen, setRawOpen] = useState(false)
  const fields = presentJournalFields(parseBodyFields(entry.body))
  const headline = fields.find((f) => f.key === 'hypothesis')
  const rest = fields.filter((f) => f !== headline)
  const outcome = classifyOutcome(entry.outcome)
  const iteration = `Iteration ${entry.iteration ?? '?'}`
  const when = entry.timestamp ? formatLocalDateTime(entry.timestamp) : undefined
  return (
    <li className="cl-card overflow-hidden">
      <header className="cl-card-head">
        <span className="shrink-0 text-[11px] font-medium" style={{ color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' }}>
          {iteration}
        </span>
        {when && (
          <span
            className="min-w-0 truncate text-[10px]"
            style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}
            title={entry.timestamp ?? undefined}
          >
            {when}
          </span>
        )}
        <div className="min-w-2 flex-1" />
        {/* The outcome's hue comes from `outcomeBadgeClass`; the chip supplies
            only the shape, as every other status chip on these cards. */}
        <span className={`cl-status-chip ${outcomeBadgeClass(outcome)}`}>
          {outcomeLabel(outcome)}
        </span>
      </header>
      {(headline || rest.length > 0) && (
        <div className="cl-card-body">
          {headline && (
            <p className="m-0 text-[12.5px] leading-relaxed" style={{ color: 'var(--text-primary)' }}>
              {headline.value}
            </p>
          )}
          {rest.length > 0 && (
            <dl className={`${headline ? 'mt-2.5' : ''} grid grid-cols-[118px_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs`}>
              {rest.map((f, idx) => (
                <FieldRow key={`${f.key}-${idx}`} field={f} />
              ))}
            </dl>
          )}
        </div>
      )}
      <footer className="cl-card-foot">
        <span className="min-w-0 flex-1 truncate text-[10.5px]" style={{ color: 'var(--text-muted)' }}>
          As the agent wrote it
        </span>
        <button
          type="button"
          onClick={() => setRawOpen(true)}
          className="cl-button shrink-0 px-2 py-0.5 text-[11px]"
          data-testid="journal-raw-entry"
        >
          Raw entry
        </button>
      </footer>
      <SourceModal
        open={rawOpen}
        onClose={() => setRawOpen(false)}
        eyebrow="Journal"
        title={iteration}
        description={when}
        source={entry.body}
        lang="markdown"
        testId="journal-raw-modal"
      />
    </li>
  )
}

function FieldRow({ field }: { field: { key: string; value: string } }) {
  return (
    <>
      {/* Same rubric as every other field label in the run panes. */}
      <dt className="cl-rubric pt-0.5">{field.key}</dt>
      <dd className="min-w-0 break-words" style={{ color: 'var(--text-secondary)' }}>{field.value}</dd>
    </>
  )
}
