import fs from 'fs'
import path from 'path'
import { readTextOrNull } from '../../../../../../../shared/lib/read-file-or'
import { journalDiffBlock } from '../../../../../../../shared/run-evidence'
import { parseCyclePatch, type ParsedCycleFile } from '../../../../../../../shared/test-view/cycle-review'
import { readJournal } from '../journal-store'
import { buildRunPaths } from '../runtime/run-paths'

/** One repair cycle's recorded diff and where it came from. */
export interface CycleDiff {
  iteration: number
  source: 'patch' | 'journal'
  /** Null when the diff came from the journal. */
  patchPath: string | null
  text: string
  /** The journal cut the diff at its size cap. A patch file is never cut. */
  truncated: boolean
  /** The journal entry's heading time; null for a patch with no entry. */
  timestamp: string | null
  /** When the cycle before this one was journaled, so when this cycle's edits
   * could start; null for the first cycle or when no earlier entry exists. */
  previousTimestamp: string | null
  files: ParsedCycleFile[]
}

export function cyclePatchPath(runDir: string, iteration: number): string {
  return path.join(runDir, 'diffs', `iteration-${iteration}.patch`)
}

/** Every cycle's diff, in cycle order. A cycle's persisted patch file is
 * preferred; runs recorded before every cycle was persisted keep only the
 * journal entry's inline block, which the journal may have cut. A cycle with
 * neither has no entry, so a replay can tell it never saw that cycle. */
export function cycleDiffs(runDir: string): Map<number, CycleDiff> {
  const diffs = new Map<number, CycleDiff>()
  const add = (iteration: number, timestamp: string | null, body: string | null): void => {
    const patchPath = cyclePatchPath(runDir, iteration)
    const patch = readTextOrNull(patchPath)
    const inline = patch === null && body !== null ? journalDiffBlock(body) : undefined
    const text = patch ?? inline?.diff
    if (text === undefined) return
    diffs.set(iteration, {
      iteration, timestamp, text, previousTimestamp: null,
      source: patch === null ? 'journal' : 'patch',
      patchPath: patch === null ? null : patchPath,
      truncated: inline?.truncated ?? false,
      files: parseCyclePatch(text),
    })
  }
  // A later entry for the same cycle is the one the journal wrote last. A
  // section only starts at an `## Iteration <n>` heading, so `readJournal`
  // always numbers it; the wire type is nullable for hand-built sections.
  const stamps = new Map<number, string | null>()
  for (const section of readJournal(buildRunPaths(runDir).diagnosisJournalPath).sections) {
    add(section.iteration!, section.timestamp, section.body)
    stamps.set(section.iteration!, section.timestamp)
  }
  let names: string[] = []
  try { names = fs.readdirSync(path.join(runDir, 'diffs')) } catch { /* no diffs directory: the journal holds every recorded diff */ }
  for (const name of names) {
    const match = /^iteration-(\d+)\.patch$/.exec(name)
    if (match && !diffs.has(Number(match[1]))) add(Number(match[1]), null, null)
  }
  for (const diff of diffs.values()) {
    const earlier = [...stamps.keys()].filter((k) => k < diff.iteration)
    if (earlier.length) diff.previousTimestamp = stamps.get(Math.max(...earlier))!
  }
  return new Map([...diffs].sort(([a], [b]) => a - b))
}
