import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { sourceFileEnglish } from './ast-to-ir'
import { parseSource } from './compiler-context'
import { renderEnglish } from './english-renderer'
import { SYNTAX_KIND_INFO, SYNTAX_KIND_INFO_BY_NAME, canonicalKindName } from './syntax-kinds'
import { VOCABULARY } from './vocabulary'

// The vocabulary doubles as the golden-test corpus: every example is parsed
// with the real engine and its render must equal exampleEnglish byte for byte
// (spec Phase 9 — exact strings, no fuzzy matching).

describe('vocabulary examples are executable goldens', () => {
  it.each(VOCABULARY.map((entry) => [entry.syntaxKind, entry] as const))('%s', (_kind, entry) => {
    const { sourceFile } = parseSource(entry.exampleFile ?? 'example.ts', entry.exampleSource)
    expect(renderEnglish(sourceFileEnglish(sourceFile))).toBe(entry.exampleEnglish)
  })
})

describe('vocabulary completeness', () => {
  it('has exactly one entry per translated SyntaxKind', () => {
    const translated = SYNTAX_KIND_INFO.filter((row) => row.disposition === 'translated').map((row) => row.name)
    const entryKinds = VOCABULARY.map((entry) => entry.syntaxKind)
    expect([...entryKinds].sort()).toEqual([...translated].sort())
    expect(new Set(entryKinds).size).toBe(entryKinds.length)
  })

  it('exercises every translated kind in at least one example AST', () => {
    const seen = new Set<string>()
    const walk = (node: ts.Node): void => {
      seen.add(canonicalKindName(node.kind))
      ts.forEachChild(node, walk)
    }
    for (const entry of VOCABULARY) {
      const { sourceFile } = parseSource(entry.exampleFile ?? 'example.ts', entry.exampleSource)
      walk(sourceFile)
      seen.add(canonicalKindName(sourceFile.kind))
    }
    const missing = VOCABULARY.map((entry) => entry.syntaxKind).filter((kind) => !seen.has(kind))
    expect(missing).toEqual([])
  })

  it("each entry's own example contains the kind it documents", () => {
    for (const entry of VOCABULARY) {
      const { sourceFile } = parseSource(entry.exampleFile ?? 'example.ts', entry.exampleSource)
      let found = false
      const walk = (node: ts.Node): void => {
        if (canonicalKindName(node.kind) === entry.syntaxKind) found = true
        if (!found) ts.forEachChild(node, walk)
      }
      walk(sourceFile)
      expect(found, `${entry.syntaxKind} not present in its own example`).toBe(true)
    }
  })

  it('describes fields consistently with the kind table', () => {
    for (const entry of VOCABULARY) {
      const info = SYNTAX_KIND_INFO_BY_NAME.get(entry.syntaxKind)
      expect(info?.disposition).toBe('translated')
      expect(entry.category).toBe(info?.category)
      expect(entry.typescriptOnly).toBe(info?.typescriptOnly === true)
      expect(entry.canonicalEnglish.length).toBeGreaterThan(0)
      expect(entry.englishTemplate.length).toBeGreaterThan(0)
      expect(entry.evaluationOrder.length).toBeGreaterThan(0)
      expect(entry.semanticInfoRequired).toBe('none')
    }
  })
})
