import ts from 'typescript'

export interface SourceRepresentationGap {
  node: ts.Node
  reason: 'syntax-fallback'
}

// Metadata belongs to the parsed source, so it cannot survive an edit or leak
// between workspaces. The development audit reads these receipts; ordinary
// translation only records the wording it already produced.
const rendered = new WeakMap<ts.Node, string>()
const gaps = new WeakMap<ts.Node, SourceRepresentationGap[]>()

export function recordSourceEnglish(node: ts.Node, text: string): string {
  rendered.set(node, text)
  return text
}

export function sourceEnglishReceipt(node: ts.Node): string | undefined {
  return rendered.get(node)
}

export function sourceRepresentationGaps(node: ts.Node): readonly SourceRepresentationGap[] {
  return gaps.get(node) ?? []
}

export function sourceSyntaxFallback(node: ts.Node, text: string): string {
  const gap: SourceRepresentationGap = { node, reason: 'syntax-fallback' }
  for (let owner: ts.Node | undefined = node; owner; owner = owner.parent) {
    const existing = gaps.get(owner) ?? []
    if (!existing.some((item) => item.node === node)) gaps.set(owner, [...existing, gap])
  }
  return recordSourceEnglish(node, text)
}
