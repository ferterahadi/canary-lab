import type { TestFileReview, TestSourceComparison, TestVersionChanges, VersionTest } from '../../../../../../shared/test-review'
import { extractTestMetadataFromSource, type ExtractedTestMetadata as Declaration } from '../../../shared/ast-extractor'
import { comparisonPatchRows } from '../../../../../../shared/comparison-patch'
import { diffSourceText } from '../../runs/logic/dirty-specs/text-diff'

import { declarationContent, pairTestDeclarations, type DeclarationPair } from '../../../shared/test-declaration-pairs'

/** Align statement fingerprints with the same diff engine as the source view.
 * Origin ranges keep wrapping, comments and tags out of meaningful highlights. */
export async function meaningfulChangeLines(pairs: DeclarationPair[]): Promise<{ before: number[]; after: number[]; alignment: NonNullable<TestFileReview['comparisonAlignment']> }> {
  const units = (side: 'before' | 'after') => pairs.flatMap((pair, index) => {
    const test = pair[side]
    if (!test) return []
    const parts = pair.before && pair.after ? declarationContent(test).units : [{ ...test, fingerprint: side }]
    return parts.map((unit) => ({ ...unit, pairIndex: index, fingerprint: `${index}:${unit.fingerprint}` }))
  })
  const before = units('before'); const after = units('after')
  const patch = await diffSourceText(before.map((unit) => unit.fingerprint).join('\n'), after.map((unit) => unit.fingerprint).join('\n'), Math.max(before.length, after.length))
  const changed = { before: new Set<number>(), after: new Set<number>() }
  const alignment: NonNullable<TestFileReview['comparisonAlignment']> = []
  let previousPair = -1
  let left = 0; let right = 0
  for (const row of comparisonPatchRows(patch)) {
    if (row.kind !== 'values') continue
    const a = row.before === null ? undefined : before[left++]
    const b = row.after === null ? undefined : after[right++]
    const range = (unit: { line: number; endLine: number } | undefined) => unit ? { line: unit.line, endLine: unit.endLine } : undefined
    const pair = { before: range(a), after: range(b) }
    const previous = alignment.at(-1)
    // Several statements can share one physical line. Keep that source line
    // once, paired with the full range of its separately wrapped counterpart.
    const pairIndex = a?.pairIndex ?? b!.pairIndex
    if (previousPair === pairIndex && previous && (pair.before && previous.before && pair.before.line <= previous.before.endLine
      || pair.after && previous.after && pair.after.line <= previous.after.endLine)) {
      for (const side of ['before', 'after'] as const) {
        const next = pair[side]
        if (next) previous[side] = { line: previous[side]?.line ?? next.line, endLine: next.endLine }
      }
    } else alignment.push(pair)
    previousPair = pairIndex
    if (row.before === row.after) continue
    for (const [side, unit] of [['before', a], ['after', b]] as const) {
      if (unit) for (let line = unit.line; line <= unit.endLine; line++) changed[side].add(line)
    }
  }
  return { before: [...changed.before], after: [...changed.after], alignment }
}

export function compareTestDeclarations(files: Array<{ file: string; before: string; after: string }>): TestSourceComparison {
  const changes: TestVersionChanges = { added: [], changed: [], removed: [] }
  const differences: TestSourceComparison['differences'] = []
  const reasons: string[] = []
  for (const { file, before, after } of files) {
    const old = extractTestMetadataFromSource(file, before)
    const current = extractTestMetadataFromSource(file, after)
    if (old.parseError || current.parseError) {
      reasons.push(`${file}: ${old.parseError ?? current.parseError}`)
      continue
    }
    const location = (test: Declaration) => ({ name: test.name, line: test.line, endLine: test.endLine })
    const target = (test: Declaration): VersionTest => ({ file, ...location(test) })
    const affected = new Set<string>()
    for (const pair of pairTestDeclarations(old.tests, current.tests)) {
      if (!pair.before) changes.added.push(target(pair.after))
      else if (!pair.after) changes.removed.push(target(pair.before))
      else if (pair.before.name !== pair.after.name || declarationContent(pair.before).fingerprint !== declarationContent(pair.after).fingerprint) {
        changes.changed.push({ ...target(pair.after), previous: location(pair.before) })
      } else continue
      if (pair.before) affected.add(pair.before.name)
      if (pair.after) affected.add(pair.after.name)
    }
    if (affected.size) differences.push({ file, affectedTests: [...affected] })
  }
  for (const tests of Object.values(changes)) tests.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
  const context = { files: files.map(({ file }) => file), differences }
  return reasons.length ? { ...context, state: 'unavailable', reasons } : { ...context, state: 'ready', changes }
}
