import ts from 'typescript'
import type { PathType } from '../../../../shared/coverage/types'

// Write a `covers` mapping onto a test as Playwright tags. This is the ONE place
// the coverage engine mutates a spec — and it only ever touches the tag list, NOT
// the test body (writing a `@req-*` tag is *mapping*, never authoring test logic;
// see plan.md "Not a spec-authoring tool").
//
// Two shapes are handled, both via precise source-text splicing (the rest of the
// file is left byte-for-byte intact so git diffs stay minimal):
//   • `test('name', async () => {})`            → insert a details object
//   • `test('name', { tag: [...] }, async ...)` → merge into the existing array
//
// Idempotent: tags already present are not duplicated.

export interface CoversTag {
  requirements: string[]
  pathTypes?: PathType[]
}

/** Render requirement + path ids into the `@req-*` / `@path-*` tag tokens. */
export function coversTagTokens(tag: CoversTag): string[] {
  const tokens: string[] = []
  for (const id of tag.requirements) tokens.push(`@req-${id}`)
  for (const p of tag.pathTypes ?? []) tokens.push(`@path-${p}`)
  return tokens
}

function getCalleeChain(expr: ts.Expression): string[] {
  if (ts.isIdentifier(expr)) return [expr.text]
  if (ts.isPropertyAccessExpression(expr)) {
    const head = getCalleeChain(expr.expression)
    if (head.length === 0) return []
    return [...head, expr.name.text]
  }
  return []
}

function isTestCall(call: ts.CallExpression): boolean {
  const chain = getCalleeChain(call.expression)
  if (chain.length === 0 || chain[0] !== 'test') return false
  if (chain.length === 1) return true
  if (chain[1] === 'step' || chain[1] === 'describe') return false
  return true
}

function getStringArg(node: ts.CallExpression): string | null {
  const arg = node.arguments[0]
  if (arg && ts.isStringLiteralLike(arg)) return arg.text
  return null
}

interface TagEdit {
  /** Splice [start, end) out of the source and replace with `text`. */
  start: number
  end: number
  text: string
}

function renderTagArray(tokens: string[]): string {
  return `[${tokens.map((t) => `'${t}'`).join(', ')}]`
}

/**
 * Compute the source edit that adds `tag` to the test named `testName`. Returns
 * null when the test isn't found or already carries every requested token (no-op
 * keeps the file untouched). Single-test resolution: the FIRST matching name.
 */
function planTagEdit(source: string, testName: string, tag: CoversTag): TagEdit | null {
  const src = ts.createSourceFile('spec.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const wanted = coversTagTokens(tag)
  if (!wanted.length) return null

  let edit: TagEdit | null = null
  const visit = (node: ts.Node): void => {
    if (edit) return
    if (ts.isCallExpression(node) && isTestCall(node) && getStringArg(node) === testName) {
      const detail = node.arguments.find((a) => ts.isObjectLiteralExpression(a)) as
        | ts.ObjectLiteralExpression
        | undefined
      if (detail) {
        edit = planMergeIntoDetail(source, detail, wanted)
      } else {
        edit = planInsertDetail(source, node, wanted)
      }
      return
    }
    node.forEachChild(visit)
  }
  visit(src)
  return edit
}

/** Insert a fresh `{ tag: [...] }` details object after the title argument. */
function planInsertDetail(
  source: string,
  call: ts.CallExpression,
  tokens: string[],
): TagEdit {
  // planInsertDetail is only called after getStringArg confirmed arguments[0]
  // is a string literal, so arguments[0] is always defined here.
  const insertAt = call.arguments[0].getEnd()
  return {
    start: insertAt,
    end: insertAt,
    text: `, { tag: ${renderTagArray(tokens)} }`,
  }
}

/** Merge new tokens into an existing details object's `tag` (string or array). */
function planMergeIntoDetail(
  source: string,
  detail: ts.ObjectLiteralExpression,
  tokens: string[],
): TagEdit | null {
  const tagProp = detail.properties.find(
    (p): p is ts.PropertyAssignment =>
      ts.isPropertyAssignment(p) &&
      (ts.isIdentifier(p.name) || ts.isStringLiteralLike(p.name)) &&
      (p.name.text === 'tag' || p.name.text === 'tags'),
  )

  if (!tagProp) {
    // Details object exists but has no `tag` — add the property at the front.
    const insertAt = detail.getStart() + 1 // just after `{`
    return {
      start: insertAt,
      end: insertAt,
      text: ` tag: ${renderTagArray(tokens)},`,
    }
  }

  const value = tagProp.initializer
  const existing: string[] = []
  if (ts.isStringLiteralLike(value)) existing.push(value.text)
  else if (ts.isArrayLiteralExpression(value)) {
    for (const el of value.elements) if (ts.isStringLiteralLike(el)) existing.push(el.text)
  }
  const merged: string[] = [...existing]
  for (const t of tokens) if (!merged.includes(t)) merged.push(t)
  if (merged.length === existing.length) return null // nothing new — no-op
  return {
    start: value.getStart(),
    end: value.getEnd(),
    text: renderTagArray(merged),
  }
}

/**
 * Return `source` with a `covers` tag written onto `testName`. If the test is
 * absent or already fully tagged, the original string is returned unchanged
 * (idempotent). Only the tag list is touched — never the test body.
 */
export function writeCoversTag(source: string, testName: string, tag: CoversTag): string {
  const edit = planTagEdit(source, testName, tag)
  if (!edit) return source
  return source.slice(0, edit.start) + edit.text + source.slice(edit.end)
}

/** Apply several mappings to one source file in a single pass (right-to-left so
 *  earlier offsets stay valid). Mappings for absent / fully-tagged tests no-op. */
export function writeCoversTags(
  source: string,
  mappings: Array<{ testName: string; tag: CoversTag }>,
): string {
  const edits: TagEdit[] = []
  for (const m of mappings) {
    const edit = planTagEdit(source, m.testName, m.tag)
    if (edit) edits.push(edit)
  }
  edits.sort((a, b) => b.start - a.start)
  let out = source
  for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end)
  return out
}
