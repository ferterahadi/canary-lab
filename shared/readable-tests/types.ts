export const READABLE_TEST_VERSION = 1 as const

export type ReadableFidelity = 'exact' | 'derived' | 'unresolved'
export type ReadableCompleteness = 'complete' | 'partial'
export type ReadableLeafRole = 'setup' | 'action' | 'check' | 'helper' | 'unknown'
export type ReadableLoopKind = 'for' | 'for-of' | 'for-await-of' | 'while' | 'do-while'

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
  // Present only when the source proves a finite iteration count.
  count?: number
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
