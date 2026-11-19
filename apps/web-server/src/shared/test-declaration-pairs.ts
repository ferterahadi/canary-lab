import ts from 'typescript'
import type { ExtractedTestMetadata } from './ast-extractor'
import { reviewCaseKey, type ReviewDeclarationPair } from '../../../../shared/test-review'

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
export function declarationContent(test: Declaration): { fingerprint: string; statements: Set<string>; units: ComparisonUnit[] } {
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

function overlap(left: Set<string>, right: Set<string>): number {
  return left.size && right.size ? [...left].filter((value) => right.has(value)).length / Math.min(left.size, right.size) : 0
}

/** Pair exact duplicates before edited names. Infer a rename only from a unique
 * content match, or a mutual best match retaining both title and substantive code.
 * Position alone cannot distinguish a rename from an unrelated replacement. */
export function pairTestDeclarations(before: Declaration[], after: Declaration[]): DeclarationPair[] {
  const old = before.map((test) => ({ test, content: declarationContent(test) }))
  const current = after.map((test) => ({ test, content: declarationContent(test) }))
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

export function reviewDeclarationPairs(pairs: DeclarationPair[]): ReviewDeclarationPair[] {
  return pairs.map(pair => {
    if (!pair.before) return { after: reviewCaseKey(pair.after) }
    if (!pair.after) return { before: reviewCaseKey(pair.before) }
    return { before: reviewCaseKey(pair.before), after: reviewCaseKey(pair.after) }
  })
}
