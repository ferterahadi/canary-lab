import type { ReadableNode, ReadableTest } from '../types'

export function readableTest(title: string, nodes: ReadableNode[] = []): ReadableTest {
  return {
    version: 2,
    title,
    completeness: 'complete',
    nodes,
  }
}
