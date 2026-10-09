import { readSpecSource } from '../../../../../../../shared/spec-files'
import { parseSourceLocation } from '../../../../../../../shared/lib/source-location'
import fs from 'fs'
import path from 'path'
import ts from 'typescript'
import { isTestCall } from '../../../../shared/test-declaration'

export function sourceKey(location: string): string {
  const { file, line } = parseSourceLocation(location)
  return line === undefined ? location : `${file}:${line}`
}

/** The spec file of a `file:line[:col]` location — the part of a test's
 *  position that survives a heal edit moving it to another line. */
export function specFileOf(location: string): string {
  return parseSourceLocation(location).file
}

export function isPlaywrightTestCall(node: ts.CallExpression): boolean {
  return isTestCall(node)
}

export function isAssertionCall(node: ts.CallExpression): boolean {
  const chain = calleeChain(node.expression)
  const idx = chain.lastIndexOf('expect')
  return idx >= 0 && idx < chain.length - 1
}

export function isWaitAssertionCall(node: ts.CallExpression): boolean {
  return matcherName(node)?.toLowerCase() === 'waitforurl'
}

export function matcherName(node: ts.CallExpression): string | undefined {
  const chain = calleeChain(node.expression)
  const idx = chain.lastIndexOf('expect')
  if (idx >= 0 && idx < chain.length - 1) return chain[chain.length - 1]
  const last = chain.at(-1)
  return last?.startsWith('waitFor') ? last : undefined
}

export function calleeChain(expr: ts.Expression): string[] {
  if (ts.isIdentifier(expr)) return [expr.text]
  if (ts.isPropertyAccessExpression(expr)) return [...calleeChain(expr.expression), expr.name.text]
  if (ts.isCallExpression(expr)) return calleeChain(expr.expression)
  return []
}

export function calledIdentifier(node: ts.CallExpression): string | undefined {
  if (ts.isIdentifier(node.expression)) return node.expression.text
  if (ts.isPropertyAccessExpression(node.expression)) return node.expression.name.text
  return undefined
}

export function functionName(node: ts.Node): string | undefined {
  if (ts.isFunctionDeclaration(node)) return node.name?.text
  if (ts.isVariableStatement(node)) {
    const decl = node.declarationList.declarations[0]
    if (decl && ts.isIdentifier(decl.name)) return decl.name.text
  }
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) return node.name.text
  return undefined
}

export function functionLikeBody(node: ts.Node): ts.ConciseBody | undefined {
  if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)) return node.body
  if (ts.isVariableStatement(node)) {
    const init = node.declarationList.declarations[0]?.initializer
    return init && (ts.isFunctionExpression(init) || ts.isArrowFunction(init)) ? init.body : undefined
  }
  if (ts.isVariableDeclaration(node)) {
    const init = node.initializer
    return init && (ts.isFunctionExpression(init) || ts.isArrowFunction(init)) ? init.body : undefined
  }
  return undefined
}

export function lineFor(node: ts.Node, src: ts.SourceFile): number {
  return src.getLineAndCharacterOfPosition(node.getStart(src)).line + 1
}

export function resolveImport(fromFile: string, specifier: string): string | undefined {
  const base = path.resolve(path.dirname(fromFile), specifier)
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    path.join(base, 'index.ts'),
    path.join(base, 'index.tsx'),
  ]
  return candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile())
}

export function safeRead(file: string): string | null {
  try {
    return readSpecSource(file)
  } catch {
    return null
  }
}
