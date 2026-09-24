// The dirty summary folded into each `/api/features` row — what the three
// review surfaces (status-bar pill, features-column badge, review dialog)
// render from. The record's `strength` verdict ships whole so the dialog can
// show each predicate's was/now; each changed test also carries the `@req-*`
// ids the live spec gives it, so a reader sees WHICH requirement an edit
// touched, not just which file. Advisory throughout (D13): nothing here is read
// by a verdict.
import fs from 'fs'
import path from 'path'
import type { TestChange } from '../../../../../../../shared/verification-strength/types'
import type { DirtySpec, SpecStrength } from './detect'
import { testRequirementsReader } from './test-requirements'

export interface DirtySpecView {
  file: string
  affectedTests: string[]
  /** Absent when the record has no readable baseline content (a hash-only
   *  legacy record, an untracked file with no run-start copy). */
  strength?: SpecStrength & { tests: Array<TestChange & { requirements?: string[] }> }
}

export interface DirtySummaryView {
  status: 'clean' | 'dirty'
  specs: DirtySpecView[]
}

export function dirtySummaryView(
  rec: { status: 'clean' | 'dirty'; dirtySpecs: DirtySpec[] } | null | undefined,
  featureDir: string,
): DirtySummaryView {
  if (!rec || rec.status !== 'dirty') return { status: 'clean', specs: [] }
  return { status: 'dirty', specs: rec.dirtySpecs.map((spec) => dirtySpecView(spec, featureDir)) }
}

function dirtySpecView(spec: DirtySpec, featureDir: string): DirtySpecView {
  const base = { file: spec.file, affectedTests: spec.affectedTests }
  if (!spec.strength) return base
  const requirementsOf = testRequirementsReader(spec.file, (rel) => readLive(featureDir, rel))
  return {
    ...base,
    strength: {
      ...spec.strength,
      tests: spec.strength.tests.map((test) => {
        const requirements = requirementsOf(test.name)
        return requirements ? { ...test, requirements } : test
      }),
    },
  }
}

function readLive(featureDir: string, rel: string): string | undefined {
  try {
    return fs.readFileSync(path.join(featureDir, rel), 'utf8')
  } catch {
    return undefined // deleted since the baseline — the test then carries no @req ids
  }
}
