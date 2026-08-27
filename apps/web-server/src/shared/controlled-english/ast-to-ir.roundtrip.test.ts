import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import {
  BINARY_OPERATOR_PHRASES,
  COMPOUND_ASSIGNMENT_PHRASES,
  MODIFIER_WORDS,
  UnsupportedSyntaxKindError,
  expressionEnglish,
  sourceFileEnglish,
  statementEnglish,
  typeEnglish,
} from './ast-to-ir'
import { parseSource } from './compiler-context'
import { renderEnglish } from './english-renderer'

const english = (source: string, file = 'example.ts'): string => {
  const { sourceFile } = parseSource(file, source)
  return renderEnglish(sourceFileEnglish(sourceFile))
}

// Spec Phase 8: semantically different structures must never render to the
// same English. Each pair here is a known look-alike; the exact renderings
// are pinned in the golden suites, so this suite asserts only the distinction.
describe('semantically different sources render differently', () => {
  const pairs: ReadonlyArray<{ name: string; left: string; right: string }> = [
    { name: 'precedence vs explicit grouping', left: 'a + b * c;', right: '(a + b) * c;' },
    { name: 'dot call vs bracket call', left: 'foo.bar();', right: 'foo["bar"]();' },
    { name: 'optional member vs optional call', left: 'foo?.bar();', right: 'foo.bar?.();' },
    { name: 'plain call vs optional call', left: 'foo();', right: 'foo?.();' },
    { name: 'nullish coalescing vs logical or', left: 'a ?? b;', right: 'a || b;' },
    { name: 'concise arrow vs block arrow', left: 'const f = () => 1;', right: 'const f = () => { return 1; };' },
    { name: 'shorthand vs longhand property', left: 'const o = { a };', right: 'const o = { a: a };' },
    { name: 'construct without vs with argument list', left: 'new Foo;', right: 'new Foo();' },
    { name: 'one declaration statement vs two', left: 'const a = 1, b = 2;', right: 'const a = 1; const b = 2;' },
    { name: 'string literal vs substitution-free template', left: 'const t = "x";', right: 'const t = `x`;' },
    { name: 'non-null on the object vs on the access', left: 'user!.name;', right: 'user.name!;' },
    { name: 'as-assertion vs angle-bracket assertion', left: 'const a = value as User;', right: 'const a = <User>value;' },
    { name: 'prefix vs postfix increment', left: '++i;', right: 'i++;' },
    { name: 'for-of vs for-in', left: 'for (const k of bag) {}', right: 'for (const k in bag) {}' },
  ]
  it.each(pairs.map((p) => [p.name, p] as const))('%s', (_name, pair) => {
    expect(english(pair.left)).not.toBe(english(pair.right))
  })
})

describe('rendering is deterministic', () => {
  it('two independent parses of the same source render identically', () => {
    const source = 'async function main() {\n  const users = await repo.find({ active: true });\n  return users.map((u) => u.name);\n}\n'
    expect(english(source)).toBe(english(source))
  })
})

// Spec Phase 6: an unmapped kind is an explicit error, never silent prose.
// Real parses cannot produce these nodes, so they are built synthetically.
describe('unsupported syntax kinds throw explicit errors', () => {
  const fake = { kind: ts.SyntaxKind.Bundle } as never

  it('carries the kind name on a typed error', () => {
    let caught: unknown
    try {
      expressionEnglish(fake)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(UnsupportedSyntaxKindError)
    const typed = caught as UnsupportedSyntaxKindError
    expect(typed.name).toBe('UnsupportedSyntaxKindError')
    expect(typed.kindName).toBe('Bundle')
    expect(typed.message).toBe('UNSUPPORTED_SYNTAX_KIND: Bundle')
  })

  it('rejects an unknown expression, statement and type kind', () => {
    expect(() => expressionEnglish(fake)).toThrow('UNSUPPORTED_SYNTAX_KIND: Bundle')
    expect(() => statementEnglish(fake)).toThrow('UNSUPPORTED_SYNTAX_KIND: Bundle')
    expect(() => typeEnglish(fake)).toThrow('UNSUPPORTED_SYNTAX_KIND: Bundle')
  })

  it('rejects a binary expression whose operator has no phrase', () => {
    const node = ts.factory.createBinaryExpression(
      ts.factory.createIdentifier('a'),
      ts.SyntaxKind.ColonToken as unknown as ts.BinaryOperator,
      ts.factory.createIdentifier('b'),
    )
    expect(() => expressionEnglish(node)).toThrow('UNSUPPORTED_SYNTAX_KIND: ColonToken')
  })

  it('rejects an unknown object literal member', () => {
    const literal = ts.factory.createObjectLiteralExpression([fake])
    expect(() => expressionEnglish(literal)).toThrow('UNSUPPORTED_SYNTAX_KIND: Bundle')
  })

  it('rejects an unknown class member', () => {
    const declaration = ts.factory.createClassDeclaration(undefined, 'C', undefined, undefined, [fake])
    expect(() => statementEnglish(declaration)).toThrow('UNSUPPORTED_SYNTAX_KIND: Bundle')
  })

  it('rejects an unknown interface member', () => {
    const declaration = ts.factory.createInterfaceDeclaration(undefined, 'I', undefined, undefined, [fake])
    expect(() => statementEnglish(declaration)).toThrow('UNSUPPORTED_SYNTAX_KIND: Bundle')
  })
})

// The operator tables are the vocabulary's operator rows; each phrase must be
// unique or two different operators would read identically (Phase 8).
describe('operator and modifier phrase tables', () => {
  it('binary operator phrases are complete and pairwise distinct', () => {
    expect(BINARY_OPERATOR_PHRASES.size).toBe(25)
    const phrases = [...BINARY_OPERATOR_PHRASES.values()]
    expect(new Set(phrases).size).toBe(phrases.length)
  })

  it('compound assignment phrases are complete and pairwise distinct', () => {
    expect(COMPOUND_ASSIGNMENT_PHRASES.size).toBe(15)
    const phrases = [...COMPOUND_ASSIGNMENT_PHRASES.values()]
    expect(new Set(phrases).size).toBe(phrases.length)
  })

  it('modifier words cover every modifier kind with distinct words', () => {
    const words = Object.values(MODIFIER_WORDS)
    expect(words).toHaveLength(15)
    expect(new Set(words).size).toBe(words.length)
  })
})
