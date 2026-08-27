export const READABLE_TEST_VERSION = 2 as const

export type ReadableFidelity = 'exact' | 'derived' | 'unsupported' | 'unresolved'
export type ReadableCompleteness = 'complete' | 'partial'
export type ReadableLeafRole = 'syntax' | 'setup' | 'action' | 'check' | 'helper' | 'unknown'
export type ReadableLoopKind = 'for' | 'for-in' | 'for-of' | 'for-await-of' | 'while' | 'do-while'

/** What a rendered span is in the source language. This stays independent
 *  from semantic meaning so a theme can emphasize either layer. */
export type ReadableSyntaxCategory =
  | 'keyword'
  | 'identifier'
  | 'literal'
  | 'operator'
  | 'function'
  | 'property'
  | 'type'

/** What a source construct is proven to do. Categories are evidence, not
 *  colours: several categories may coexist on one span. */
export type ReadableSemanticCategory =
  | 'error-control-flow'
  | 'assertion'
  | 'external-api'
  | 'database'
  | 'branch'
  | 'iteration'
  | 'return'
  | 'declaration'
  | 'assignment'
  | 'function-call'
  | 'async'
  | 'filesystem'
  | 'logging'
  | 'unknown'

/** Extra module specifiers whose imported clients carry known semantics.
 *  Matching a method name alone is never sufficient. */
export interface ReadableSemanticRuleConfig {
  apiClients?: readonly string[]
  databaseClients?: readonly string[]
}

export interface ReadableSourceRange {
  /** Zero-based offsets in the complete source file. */
  start: number
  end: number
}

export interface ReadableEnglishSpan {
  text: string
  kind?: 'code'
  syntaxCategory?: ReadableSyntaxCategory
  /** Ordered from most specific to least specific; no category is discarded. */
  semanticCategories?: ReadableSemanticCategory[]
  sourceRange?: ReadableSourceRange
}

/** Structured controlled English. `text` is the exact deterministic plain
 *  rendering of `spans`; consumers that support highlighting render the spans. */
export interface ReadableEnglishBlock {
  kind: 'sentence' | 'control-flow'
  text: string
  spans: ReadableEnglishSpan[]
  semanticCategories?: ReadableSemanticCategory[]
  sourceRange?: ReadableSourceRange
}

export interface ReadableSource {
  file: string
  startLine: number
  endLine: number
  snippet: string
}

export type ReadableStoryRole = 'setup' | 'action' | 'check'

export type ReadableStoryFlowKind =
  | 'scope'
  | 'condition'
  | 'then'
  | 'otherwise'
  | 'switch'
  | 'case'
  | 'loop'
  | 'retry'
  | 'try'
  | 'catch'
  | 'finally'

export interface ReadableStorySpan {
  text: string
  kind?: 'variable'
}

interface ReadableStoryItemBase {
  id: string
  text: string
  spans: ReadableStorySpan[]
  fidelity: 'exact' | 'derived'
  source: ReadableSource
}

/** One plain-language fact in the default test story. `kind` is optional so
 * cached version-2 payloads written before nested flows remain valid. */
export interface ReadableStoryStep extends ReadableStoryItemBase {
  kind?: 'step'
  role: ReadableStoryRole
}

/** A source-authored execution boundary. Children stay in authored order, so
 * a callback, loop, branch, or retry never reads as if it ran only once. */
export interface ReadableStoryFlow extends ReadableStoryItemBase {
  kind: 'flow'
  role: ReadableStoryRole
  flowKind: ReadableStoryFlowKind
  children: ReadableStoryItem[]
}

export type ReadableStoryItem = ReadableStoryStep | ReadableStoryFlow

/** The reader-first altitude in authored execution order. Each row carries its
 * setup/action/check role instead of being moved into a role-based bucket. */
export interface ReadableTestStory {
  steps: ReadableStoryItem[]
}

interface ReadableNodeBase {
  id: string
  /** Exhaustive syntax-level wording retained for version-2 clients. */
  text: string
  /** Natural, structured wording used by current clients when present. */
  english?: ReadableEnglishBlock
  fidelity: ReadableFidelity
  source: ReadableSource
}

export interface ReadableLeafNode extends ReadableNodeBase {
  kind: 'leaf'
  role: ReadableLeafRole
}

export interface ReadableGroupNode extends ReadableNodeBase {
  kind: 'group'
  // Present when the group is an expanded helper-call body rather than an
  // authored `test.step` block. Consumers pick their altitude: the web UI
  // shows only the call as a single line, while the evaluation flowchart
  // keeps descending into the children.
  origin?: 'helper'
  /** Catch/finally headers align with their owning Try header in English. */
  controlRole?: 'catch' | 'finally'
  children: ReadableNode[]
}

export interface ReadableBranchPath extends ReadableNodeBase {
  role?: 'then' | 'otherwise' | 'case' | 'default'
  children: ReadableNode[]
}

export interface ReadableBranchNode extends ReadableNodeBase {
  kind: 'branch'
  paths: ReadableBranchPath[]
}

export interface ReadableLoopNode extends ReadableNodeBase {
  kind: 'loop'
  loopKind: ReadableLoopKind
  children: ReadableNode[]
}

export type ReadableNode =
  | ReadableLeafNode
  | ReadableGroupNode
  | ReadableBranchNode
  | ReadableLoopNode

export interface ReadableTest {
  version: typeof READABLE_TEST_VERSION
  title: string
  completeness: ReadableCompleteness
  /** Optional so version-2 payloads cached by an older server still render. */
  story?: ReadableTestStory
  nodes: ReadableNode[]
}
