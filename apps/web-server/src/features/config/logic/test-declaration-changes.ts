import ts from 'typescript'
import type { TestSourceComparison, TestVersionChanges, VersionTest } from '../../../../../../shared/test-review'
import { extractTestMetadataFromSource, type ExtractedTestMetadata } from '../../../shared/ast-extractor'
import { comparisonPatchRows } from '../../../../../../shared/comparison-patch'
import { diffSourceText } from '../../runs/logic/dirty-specs/text-diff'

type Declaration = ExtractedTestMetadata
export type DeclarationPair = { before: Declaration; after: Declaration } | { before: Declaration; after?: undefined } | { before?: undefined; after: Declaration }

/** Compare executable declarations, preserving modifiers and callback parameters.
 * Only registration metadata is omitted: a `tag` inside the callback is data. */
function structure(node: ts.Node, omittedBody?: ts.Node): unknown[] {
  if (node === omittedBody) return [node.kind]
  const children: unknown[] = []
  node.forEachChild((child) => { children.push(structure(child, omittedBody)) })
  return [node.kind, ...(ts.isVariableDeclarationList(node) ? [node.flags & ts.NodeFlags.BlockScoped] : []),
    ...(ts.isIdentifier(node) || ts.isPrivateIdentifier(node) || ts.isLiteralExpression(node) ? [node.text] : children)]
}

interface ComparisonUnit { fingerprint: string; line: number; endLine: number }
function content(test: Declaration): { fingerprint: string; statements: Set<string>; units: ComparisonUnit[] } {
  const source = ts.createSourceFile('test.ts', test.declarationSource, ts.ScriptTarget.Latest, true)
  // The metadata extractor returns the text of a test CallExpression.
  const call = (source.statements[0] as ts.ExpressionStatement).expression as ts.CallExpression
  const args = call.arguments.slice(1).flatMap((argument) => {
    if (!ts.isObjectLiteralExpression(argument)) return [argument]
    const properties = argument.properties.filter((property) => !property.name
      || !(ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name))
      || !['tag', 'annotation'].includes(property.name.text))
    return properties.length ? [ts.factory.updateObjectLiteralExpression(argument, properties)] : []
  })
  const node = ts.factory.updateCallExpression(call, call.expression, call.typeArguments, args)
  const callback = args.find((argument) => ts.isArrowFunction(argument) || ts.isFunctionExpression(argument))
  const body = callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) ? callback.body : undefined
  const statements = body ? ts.isBlock(body) ? body.statements : [body] : []
  const lineAt = (position: number) => source.getLineAndCharacterOfPosition(position).line + test.line
  const units = [{ fingerprint: JSON.stringify([test.name, structure(node, body)]), line: test.line, endLine: body ? lineAt(body.getStart(source)) : test.endLine },
    ...statements.map((statement) => ({ fingerprint: JSON.stringify(structure(statement)), line: lineAt(statement.getStart(source)), endLine: lineAt(statement.getEnd()) }))]
  return { fingerprint: JSON.stringify(structure(node)), statements: new Set(units.slice(1).map((unit) => unit.fingerprint)), units }
}

/** Align statement fingerprints with the same diff engine as the source view.
 * Origin ranges keep wrapping, comments and tags out of meaningful highlights. */
export async function meaningfulChangeLines(pairs: DeclarationPair[]): Promise<{ before: number[]; after: number[] }> {
  const units = (side: 'before' | 'after') => pairs.flatMap((pair, index) => {
    const test = pair[side]
    if (!test) return []
    const parts = pair.before && pair.after ? content(test).units : [{ ...test, fingerprint: side }]
    return parts.map((unit) => ({ ...unit, fingerprint: `${index}:${unit.fingerprint}` }))
  })
  const before = units('before'); const after = units('after')
  const patch = await diffSourceText(before.map((unit) => unit.fingerprint).join('\n'), after.map((unit) => unit.fingerprint).join('\n'), Math.max(before.length, after.length))
  const changed = { before: new Set<number>(), after: new Set<number>() }
  let left = 0; let right = 0
  for (const row of comparisonPatchRows(patch)) {
    if (row.kind !== 'values') continue
    const a = row.before === null ? undefined : before[left++]
    const b = row.after === null ? undefined : after[right++]
    if (row.before === row.after) continue
    for (const [side, unit] of [['before', a], ['after', b]] as const) {
      if (unit) for (let line = unit.line; line <= unit.endLine; line++) changed[side].add(line)
    }
  }
  return { before: [...changed.before], after: [...changed.after] }
}

function overlap(left: Set<string>, right: Set<string>): number {
  return left.size && right.size ? [...left].filter((value) => right.has(value)).length / Math.min(left.size, right.size) : 0
}

/** Pair exact duplicates before edited names. Infer a rename only from a unique
 * content match, or a mutual best match retaining both title and substantive code.
 * Position alone cannot distinguish a rename from an unrelated replacement. */
export function pairTestDeclarations(before: Declaration[], after: Declaration[]): DeclarationPair[] {
  const old = before.map((test) => ({ test, content: content(test) }))
  const current = after.map((test) => ({ test, content: content(test) }))
  const pairs: DeclarationPair[] = []
  const pair = (left: typeof old[number], right: typeof current[number]) => {
    pairs.push({ before: left.test, after: right.test })
    old.splice(old.indexOf(left), 1)
    current.splice(current.indexOf(right), 1)
  }
  for (const right of [...current]) {
    const left = old.find((candidate) => candidate.test.name === right.test.name && candidate.content.fingerprint === right.content.fingerprint)
    if (left) pair(left, right)
  }
  for (const right of [...current]) {
    const left = old.find((candidate) => candidate.test.name === right.test.name)
    if (left) pair(left, right)
  }
  const score = (left: typeof old[number], right: typeof current[number]): number => {
    if (left.content.fingerprint === right.content.fingerprint) return 1
    const words = (text: string) => new Set(text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
    const title = overlap(words(left.test.name), words(right.test.name))
    const a = left.content.statements; const b = right.content.statements
    const body = overlap(a, b)
    return title >= 0.6 && Math.min(a.size, b.size) >= 3 && body >= 0.6 ? (title + body) / 2 * 0.99 : 0
  }
  const candidates = old.flatMap((left) => current.map((right) => ({ left, right, score: score(left, right) }))).filter((candidate) => candidate.score > 0)
  for (const candidate of candidates) {
    if (candidates.some((other) => other !== candidate && (other.left === candidate.left || other.right === candidate.right) && other.score >= candidate.score)) continue
    pair(candidate.left, candidate.right)
  }
  return [...pairs, ...old.map(({ test }) => ({ before: test })), ...current.map(({ test }) => ({ after: test }))]
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
      else if (pair.before.name !== pair.after.name || content(pair.before).fingerprint !== content(pair.after).fingerprint) {
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
