export const READABLE_TEST_VERSION = 2 as const

export type ReadableFidelity = 'exact' | 'derived' | 'unsupported' | 'unresolved'
export type ReadableCompleteness = 'complete' | 'partial'
export type ReadableLeafRole = 'syntax' | 'setup' | 'action' | 'check' | 'helper' | 'unknown'
export type ReadableLoopKind = 'for' | 'for-in' | 'for-of' | 'for-await-of' | 'while' | 'do-while'

export interface ReadableSource {
  file: string
  startLine: number
  endLine: number
  snippet: string
}

interface ReadableNodeBase {
  id: string
  text: string
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
  children: ReadableNode[]
}

export interface ReadableBranchPath extends ReadableNodeBase {
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
  nodes: ReadableNode[]
}
