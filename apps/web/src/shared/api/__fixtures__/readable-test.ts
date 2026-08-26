import type { ReadableNode, ReadableTest } from '../types'

export function readableTest(title: string, nodes: ReadableNode[] = []): ReadableTest {
  return {
    version: 1,
    title,
    completeness: 'complete',
    nodes,
  }
}
