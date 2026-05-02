/**
 * AST round-trip helpers for feature.config.{cjs,js,ts} and
 * playwright.config.{ts,js,cjs}. Edits are surgical when possible
 * (recast preserves untouched whitespace/comments) and fall back to
 * regenerating object/array literals when the structure changes.
 *
 * Non-literal expressions (e.g. `__dirname`, `process.env.CI ? 2 : 1`)
 * are encoded with the `$expr` sentinel so the UI can show them as
 * read-only and round-trip them through unchanged.
 */
import * as recast from 'recast'
import { namedTypes as N } from 'ast-types'
import type * as K from 'ast-types/lib/gen/kinds'
// eslint-disable-next-line @typescript-eslint/no-require-imports
const tsParser = require('recast/parsers/babel-ts')

const b = recast.types.builders

const EXPR = '$expr' as const
export interface ExprPlaceholder { [EXPR]: string }

export type ConfigValue =
  | null
  | boolean
  | number
  | string
  | ExprPlaceholder
  | ConfigValue[]
  | { [k: string]: ConfigValue }

export interface ParsedConfig {
  value: ConfigValue
  /** Field paths whose value is a non-literal expression (read-only in UI). */
  complexFields: string[]
}

const parseOpts = { parser: tsParser }

function parseSource(source: string): ReturnType<typeof recast.parse> {
  return recast.parse(source, parseOpts)
}

function printSource(ast: ReturnType<typeof recast.parse>): string {
  return recast.print(ast, { quote: 'single' }).code
}

function deepEqual(a: ConfigValue, b: ConfigValue): boolean {
  if (a === b) return true
  if (a === null || b === null) return false
  if (typeof a !== typeof b) return false
  if (typeof a !== 'object') return false
  // ExprPlaceholder match by source string
  const ae = (a as ExprPlaceholder)[EXPR]
  const be = (b as ExprPlaceholder)[EXPR]
  if (typeof ae === 'string' || typeof be === 'string') return ae === be
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false
    if (a.length !== b.length) return false
    return a.every((v, i) => deepEqual(v, b[i]))
  }
  const aObj = a as { [k: string]: ConfigValue }
  const bObj = b as { [k: string]: ConfigValue }
  const aKeys = Object.keys(aObj)
  const bKeys = Object.keys(bObj)
  if (aKeys.length !== bKeys.length) return false
  return aKeys.every((k) => k in bObj && deepEqual(aObj[k], bObj[k]))
}

function propertyKeyName(prop: N.ObjectProperty | N.Property): string | null {
  const k = (prop as N.ObjectProperty).key
  if (k.type === 'Identifier') return k.name
  if (k.type === 'StringLiteral') return k.value
  return null
}

/** Surgical patch — only the keys whose values changed get regenerated.
 *  Untouched properties keep their original AST node (and any comments
 *  attached to it). */
function patchObjectLiteral(
  node: N.ObjectExpression,
  next: { [k: string]: ConfigValue },
): void {
  const seen = new Set<string>()
  const kept: typeof node.properties = []
  for (const p of node.properties) {
    if (p.type !== 'ObjectProperty' && p.type !== 'Property') {
      kept.push(p)
      continue
    }
    const key = propertyKeyName(p as N.ObjectProperty)
    if (key == null) {
      kept.push(p)
      continue
    }
    if (!(key in next)) {
      // Removed by the patch; drop it.
      continue
    }
    seen.add(key)
    const prop = p as N.ObjectProperty
    const currentVal = nodeToValue(prop.value as K.ExpressionKind, [], '')
    const nextVal = next[key]
    if (!deepEqual(currentVal, nextVal)) {
      prop.value = valueToNode(nextVal)
    }
    kept.push(p)
  }
  for (const [k, v] of Object.entries(next)) {
    if (seen.has(k)) continue
    kept.push(b.objectProperty(b.identifier(k), valueToNode(v)))
  }
  node.properties = kept
}

// ─── extraction ───────────────────────────────────────────────────────────

/** Convert a Babel AST node to a ConfigValue tree. Non-literal expressions
 *  collapse into `{ $expr: '<source-snippet>' }`. */
function nodeToValue(
  node: K.ExpressionKind | null | undefined,
  complex: string[],
  path: string,
): ConfigValue {
  if (!node) return null
  switch (node.type) {
    case 'NullLiteral':
      return null
    case 'BooleanLiteral':
      return node.value
    case 'NumericLiteral':
      return node.value
    case 'StringLiteral':
      return node.value
    case 'ArrayExpression':
      return node.elements.map((el, i) =>
        el && el.type !== 'SpreadElement'
          ? nodeToValue(el as K.ExpressionKind, complex, `${path}[${i}]`)
          : null,
      )
    case 'ObjectExpression': {
      const out: { [k: string]: ConfigValue } = {}
      for (const prop of node.properties) {
        if (prop.type !== 'ObjectProperty' && prop.type !== 'Property') continue
        const key = (() => {
          const k = (prop as N.ObjectProperty).key
          if (k.type === 'Identifier') return k.name
          if (k.type === 'StringLiteral') return k.value
          return null
        })()
        if (key == null) continue
        out[key] = nodeToValue(
          (prop as N.ObjectProperty).value as K.ExpressionKind,
          complex,
          path ? `${path}.${key}` : key,
        )
      }
      return out
    }
    case 'UnaryExpression': {
      const u = node as N.UnaryExpression
      if (u.operator === '-' && u.argument.type === 'NumericLiteral') {
        return -(u.argument as N.NumericLiteral).value
      }
      complex.push(path)
      return { [EXPR]: recast.print(node).code }
    }
    default:
      complex.push(path)
      return { [EXPR]: recast.print(node).code }
  }
}

/** Build a Babel AST node from a ConfigValue tree. `$expr` placeholders
 *  are re-parsed so they round-trip as the original expression. */
function valueToNode(value: ConfigValue): K.ExpressionKind {
  if (value === null) return b.nullLiteral()
  if (typeof value === 'boolean') return b.booleanLiteral(value)
  if (typeof value === 'number') {
    return value < 0
      ? b.unaryExpression('-', b.numericLiteral(Math.abs(value)))
      : b.numericLiteral(value)
  }
  if (typeof value === 'string') return b.stringLiteral(value)
  if (Array.isArray(value)) {
    return b.arrayExpression(value.map((v) => valueToNode(v) as K.ExpressionKind))
  }
  if (typeof value === 'object') {
    if (EXPR in value && typeof (value as ExprPlaceholder)[EXPR] === 'string') {
      const code = (value as ExprPlaceholder)[EXPR]
      const parsed = recast.parse(`(${code})`, parseOpts)
      // The wrapping parens make the body a single ExpressionStatement.
      const expr = (parsed.program.body[0] as N.ExpressionStatement).expression
      return expr
    }
    const props = Object.entries(value).map(([k, v]) =>
      b.objectProperty(b.identifier(k), valueToNode(v)),
    )
    return b.objectExpression(props)
  }
  // Defensive: unknown shape
  return b.nullLiteral()
}

// ─── locating the config object ───────────────────────────────────────────

interface ConfigLocation {
  /** The root ObjectExpression node we read/write. */
  node: N.ObjectExpression
}

/** Find the config object literal for a feature.config.{cjs,js,ts} file.
 *  Supports `const config = {…}; module.exports = { config }`,
 *  `module.exports = { config: {…} }`, and `module.exports.config = {…}`. */
function locateFeatureConfigObject(ast: ReturnType<typeof recast.parse>): ConfigLocation | null {
  const program = ast.program as N.Program

  // Pass 1 — collect top-level const declarations to follow shorthand refs.
  const topConsts = new Map<string, N.VariableDeclarator>()
  for (const stmt of program.body) {
    if (stmt.type === 'VariableDeclaration') {
      for (const d of stmt.declarations) {
        if (d.type === 'VariableDeclarator' && d.id.type === 'Identifier') {
          topConsts.set(d.id.name, d)
        }
      }
    }
  }

  // Pass 2 — walk module.exports / exports.config patterns.
  for (const stmt of program.body) {
    if (stmt.type !== 'ExpressionStatement') continue
    const expr = stmt.expression
    if (expr.type !== 'AssignmentExpression') continue
    const left = expr.left
    const right = expr.right

    // module.exports.config = {...}
    if (
      left.type === 'MemberExpression' &&
      left.object.type === 'MemberExpression' &&
      left.object.object.type === 'Identifier' &&
      left.object.object.name === 'module' &&
      left.object.property.type === 'Identifier' &&
      left.object.property.name === 'exports' &&
      left.property.type === 'Identifier' &&
      left.property.name === 'config' &&
      right.type === 'ObjectExpression'
    ) {
      return { node: right }
    }

    // module.exports = { config: {...} } | { config }
    if (
      left.type === 'MemberExpression' &&
      left.object.type === 'Identifier' &&
      left.object.name === 'module' &&
      left.property.type === 'Identifier' &&
      left.property.name === 'exports' &&
      right.type === 'ObjectExpression'
    ) {
      for (const p of right.properties) {
        if (p.type !== 'ObjectProperty' && p.type !== 'Property') continue
        const prop = p as N.ObjectProperty
        if (prop.key.type === 'Identifier' && prop.key.name === 'config') {
          if (prop.shorthand && prop.value.type === 'Identifier') {
            const decl = topConsts.get(prop.value.name)
            if (decl?.init?.type === 'ObjectExpression') {
              return { node: decl.init }
            }
          }
          if (prop.value.type === 'ObjectExpression') {
            return { node: prop.value }
          }
        }
      }
    }
  }

  return null
}

/** Find the playwright config object — first arg of `defineConfig({…})`,
 *  whether wrapped in `module.exports = …`, `export default …`, or
 *  assigned to a top-level const. Falls back to the bare `module.exports`
 *  object when defineConfig isn't used. */
function locatePlaywrightConfigObject(ast: ReturnType<typeof recast.parse>): ConfigLocation | null {
  const program = ast.program as N.Program

  const findInDefineConfigCall = (call: N.CallExpression): ConfigLocation | null => {
    if (call.callee.type !== 'Identifier' || call.callee.name !== 'defineConfig') return null
    const arg = call.arguments[0]
    if (arg?.type !== 'ObjectExpression') return null
    return { node: arg }
  }

  for (const stmt of program.body) {
    // export default defineConfig({...})
    if (stmt.type === 'ExportDefaultDeclaration') {
      const d = stmt.declaration
      if (d.type === 'CallExpression') {
        const loc = findInDefineConfigCall(d as N.CallExpression)
        if (loc) return loc
      }
      if (d.type === 'ObjectExpression') {
        return { node: d }
      }
    }
    if (stmt.type !== 'ExpressionStatement') continue
    const expr = stmt.expression
    if (expr.type !== 'AssignmentExpression') continue
    const left = expr.left
    const right = expr.right
    const isModuleExports =
      left.type === 'MemberExpression' &&
      left.object.type === 'Identifier' &&
      left.object.name === 'module' &&
      left.property.type === 'Identifier' &&
      left.property.name === 'exports'
    if (!isModuleExports) continue
    if (right.type === 'CallExpression') {
      const loc = findInDefineConfigCall(right as N.CallExpression)
      if (loc) return loc
    }
    if (right.type === 'ObjectExpression') {
      return { node: right }
    }
  }
  return null
}

// ─── public API ───────────────────────────────────────────────────────────

export interface ReadResult extends ParsedConfig {
  /** Original source — useful when the editor wants to show a "raw" tab. */
  source: string
}

export function readFeatureConfig(source: string): ReadResult {
  const ast = parseSource(source)
  const loc = locateFeatureConfigObject(ast)
  if (!loc) throw new Error('Unable to locate feature config object literal')
  const complex: string[] = []
  const value = nodeToValue(loc.node, complex, '')
  return { value, complexFields: complex, source }
}

export function writeFeatureConfig(source: string, next: ConfigValue): string {
  const ast = parseSource(source)
  const loc = locateFeatureConfigObject(ast)
  if (!loc) throw new Error('Unable to locate feature config object literal')
  if (typeof next !== 'object' || next === null || Array.isArray(next)) {
    throw new Error('Feature config must be a plain object')
  }
  patchObjectLiteral(loc.node, next as { [k: string]: ConfigValue })
  return printSource(ast)
}

export function readPlaywrightConfig(source: string): ReadResult {
  const ast = parseSource(source)
  const loc = locatePlaywrightConfigObject(ast)
  if (!loc) throw new Error('Unable to locate playwright config object literal')
  const complex: string[] = []
  const value = nodeToValue(loc.node, complex, '')
  return { value, complexFields: complex, source }
}

export function writePlaywrightConfig(source: string, next: ConfigValue): string {
  const ast = parseSource(source)
  const loc = locatePlaywrightConfigObject(ast)
  if (!loc) throw new Error('Unable to locate playwright config object literal')
  if (typeof next !== 'object' || next === null || Array.isArray(next)) {
    throw new Error('Playwright config must be a plain object')
  }
  patchObjectLiteral(loc.node, next as { [k: string]: ConfigValue })
  return printSource(ast)
}
