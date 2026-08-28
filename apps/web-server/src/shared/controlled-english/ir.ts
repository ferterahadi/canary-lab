// The Intermediate Representation (IR) between the TypeScript AST and rendered
// controlled English. Translation happens in two deterministic steps
// (AST → EnglishNode → text) so consumers can re-render the same structure at
// different layouts (block for the UI, first-line summaries for flowcharts)
// without re-walking the AST.

/** A finished inline fragment: a backticked name, a quoted literal, a fixed
 *  keyword. Atoms never wrap. */
export interface EnglishAtom {
  kind: 'atom'
  tag: string
  text: string
}

/** Inline-only composition: parts joined by single spaces. A seq is used for
 *  constructs that read as one phrase (operators, type expressions) and is
 *  inline exactly when every part is. */
export interface EnglishSeq {
  kind: 'seq'
  tag: string
  parts: EnglishNode[]
}

/** One labelled slot of a clause: `label child` inline, or `label:` followed
 *  by the child's indented lines. A segment with a list renders its items
 *  joined by ` and ` inline, or one per line in block layout. `separate`
 *  forces the `label:` + indented form even for an inline child — used where
 *  the grammar keeps a value on its own line (a call argument that is not a
 *  plain name or literal, a verb in a value slot). */
export interface EnglishSegment {
  label: string
  child?: EnglishNode
  list?: EnglishNode[]
  separate?: true
}

/** A verb-like construct (call, declare, if, …) made of ordered segments.
 *  `layout: 'block'` pins the clause to one-segment-per-line even when all
 *  children are inline — used for statement bodies and for nesting rules like
 *  "a call whose argument is itself a call renders as a block". */
export interface EnglishClause {
  kind: 'clause'
  tag: string
  segments: EnglishSegment[]
  layout?: 'block'
}

export type EnglishNode = EnglishAtom | EnglishSeq | EnglishClause

export function atom(tag: string, text: string): EnglishAtom {
  return { kind: 'atom', tag, text }
}

export function seq(tag: string, parts: EnglishNode[]): EnglishSeq {
  return { kind: 'seq', tag, parts }
}

export function clause(tag: string, segments: EnglishSegment[], layout?: 'block'): EnglishClause {
  return layout ? { kind: 'clause', tag, segments, layout } : { kind: 'clause', tag, segments }
}

/** Tags whose clauses force the surrounding construct into block layout when
 *  they appear in a value slot (an argument, an initializer, an operand):
 *  `a(b(c()))` must never flatten into one line. Phrase-like clauses such as
 *  property access stay inline-eligible and are deliberately absent. */
export const VERB_TAGS: ReadonlySet<string> = new Set([
  'call',
  'construct',
  'await',
  'yield',
  'yield-each',
  'arrow-function',
  'function-expression',
  'class-expression',
  'conditional',
  'assign',
  'comma-sequence',
  'tagged-template',
  'increment',
  'decrement',
  'delete',
  'void-of',
])

export function isVerbNode(node: EnglishNode): boolean {
  return node.kind === 'clause' && VERB_TAGS.has(node.tag)
}
