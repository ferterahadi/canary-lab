import type { ReadableNode, ReadableTest } from '../types'

export function readableTest(title: string, nodes: ReadableNode[] = []): ReadableTest {
  return {
    version: 2,
    title,
    completeness: 'complete',
    ...(nodes.length ? {
      story: {
        steps: nodes.map((node) => ({
          id: node.id,
          role: node.kind === 'leaf' && (node.role === 'setup' || node.role === 'check')
            ? node.role
            : 'action' as const,
          text: node.text,
          spans: [{ text: node.text }],
          fidelity: node.fidelity === 'exact' ? 'exact' as const : 'derived' as const,
          source: node.source,
        })),
      },
    } : {}),
    nodes,
  }
}
