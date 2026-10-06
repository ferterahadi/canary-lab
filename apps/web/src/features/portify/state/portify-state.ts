import { portifyIndexEntry, type PortifyIndexEntry } from '@shared/portify-index'
import type { PortifyManifest } from '@/shared/api/portify'
import {
  byStartedDesc,
  createRecordIndex,
  type RecordIndexAction,
  type RecordIndexFrame,
  type RecordIndexState,
} from '@/shared/state/record-index-store'

// Pure reducer driving PortifyContext, built by the shared record-index store
// so it unit-tests in the node vitest config (no jsdom). The server pushes the
// full manifest on every change (status, attempt, diff, verification), so a
// single `update` frame covers every transition without bespoke frame types.

export const portifyIndex = createRecordIndex<PortifyIndexEntry, PortifyManifest, 'workflows', 'workflowId'>({
  keys: { list: 'workflows', id: 'workflowId' },
  entryOf: portifyIndexEntry,
  compareEntries: byStartedDesc,
})

export type PortifyStreamFrame = RecordIndexFrame<PortifyIndexEntry, PortifyManifest, 'workflows', 'workflowId'>
export type PortifyAction = RecordIndexAction<PortifyIndexEntry, PortifyManifest, 'workflows', 'workflowId'>
export type PortifyState = RecordIndexState<PortifyIndexEntry, PortifyManifest, 'workflows'>

/**
 * The workflowId of a feature's most-recent SAVED port-ification — the one that
 * produced the live overlay, so "View latest" opens exactly what's on disk.
 * Returns undefined for a portified-but-record-less feature (legacy overlay, or
 * the record was pruned), in which case there's nothing to view.
 */
export function latestSavedWorkflowId(
  workflows: PortifyIndexEntry[],
  feature: string,
): string | undefined {
  return workflows
    .filter((w) => w.feature === feature && w.status === 'saved')
    .sort(byStartedDesc)[0]?.workflowId
}
