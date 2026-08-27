import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { CONTROLLED_ENGLISH_TYPESCRIPT_VERSION, installedTypescriptVersion } from './compiler-context'
import {
  SYNTAX_KIND_INFO,
  SYNTAX_KIND_INFO_BY_NAME,
  canonicalKindName,
  isMarkerName,
} from './syntax-kinds'

// The vocabulary is only trustworthy if it is provably total against the
// compiler that defines the grammar. These tests fail on any TypeScript
// upgrade (version pin) and on any enum member the table forgot or invented
// (totality in both directions), forcing a deliberate re-audit.

function enumNamesByValue(): Map<number, string[]> {
  const byValue = new Map<number, string[]>()
  for (const key of Object.keys(ts.SyntaxKind)) {
    if (/^\d+$/.test(key)) continue
    const value = ts.SyntaxKind[key as keyof typeof ts.SyntaxKind]
    const names = byValue.get(value) ?? []
    names.push(key)
    byValue.set(value, names)
  }
  return byValue
}

describe('syntax-kinds inventory', () => {
  it('is written for the installed TypeScript version', () => {
    expect(installedTypescriptVersion()).toBe(CONTROLLED_ENGLISH_TYPESCRIPT_VERSION)
  })

  it('covers every non-marker SyntaxKind of the installed compiler under its canonical name', () => {
    // Coverage is by enum *value*: a deprecated alias (AssertClause,
    // JSDocComment, …) shares its value with the canonical name, and only the
    // canonical name gets a row.
    const missing: string[] = []
    for (const [value, names] of enumNamesByValue()) {
      if (names.every(isMarkerName)) continue
      if (!SYNTAX_KIND_INFO_BY_NAME.has(canonicalKindName(value))) missing.push(names.join('/'))
    }
    expect(missing).toEqual([])
  })

  it('lists only canonical names — never a deprecated alias', () => {
    const aliased = SYNTAX_KIND_INFO.filter(
      (row) => canonicalKindName(ts.SyntaxKind[row.name as keyof typeof ts.SyntaxKind]) !== row.name,
    )
    expect(aliased.map((row) => row.name)).toEqual([])
  })

  it('contains no row the installed compiler does not define', () => {
    const invented = SYNTAX_KIND_INFO.filter((row) => !(row.name in ts.SyntaxKind))
    expect(invented.map((row) => row.name)).toEqual([])
  })

  it('contains no duplicate rows', () => {
    const names = SYNTAX_KIND_INFO.map((row) => row.name)
    expect(new Set(names).size).toBe(names.length)
    expect(SYNTAX_KIND_INFO_BY_NAME.size).toBe(names.length)
  })

  it('classifies every row with a disposition and category', () => {
    for (const row of SYNTAX_KIND_INFO) {
      expect(row.category.length).toBeGreaterThan(0)
      expect(row.disposition.length).toBeGreaterThan(0)
    }
  })
})

describe('isMarkerName', () => {
  it('recognizes First*/Last*/Count range markers', () => {
    expect(isMarkerName('FirstToken')).toBe(true)
    expect(isMarkerName('LastKeyword')).toBe(true)
    expect(isMarkerName('Count')).toBe(true)
  })

  it('keeps real kinds that merely start with those letters', () => {
    expect(isMarkerName('ForStatement')).toBe(false)
    expect(isMarkerName('LabeledStatement')).toBe(false)
    expect(isMarkerName('CountKeyword')).toBe(false)
  })
})

describe('canonicalKindName', () => {
  it('names an unaliased kind', () => {
    expect(canonicalKindName(ts.SyntaxKind.CallExpression)).toBe('CallExpression')
  })

  it('prefers the modern name over a deprecated alias sharing the value', () => {
    // The enum reverse map would return the *last*-declared alias here.
    expect(canonicalKindName(ts.SyntaxKind.ImportAttributes)).toBe('ImportAttributes')
    expect(canonicalKindName(ts.SyntaxKind.ImportAttribute)).toBe('ImportAttribute')
    expect(canonicalKindName(ts.SyntaxKind.JSDoc)).toBe('JSDoc')
  })

  it('never returns a First*/Last* range marker', () => {
    expect(canonicalKindName(ts.SyntaxKind.NoSubstitutionTemplateLiteral)).toBe('NoSubstitutionTemplateLiteral')
    expect(canonicalKindName(ts.SyntaxKind.NumericLiteral)).toBe('NumericLiteral')
  })

  it('falls back to the raw value for a number outside the enum', () => {
    expect(canonicalKindName(-1 as ts.SyntaxKind)).toBe('SyntaxKind -1')
  })

  it('resolves every enum value to a non-marker name', () => {
    for (const [value, names] of enumNamesByValue()) {
      const canonical = canonicalKindName(value)
      if (names.every(isMarkerName)) {
        // A value reachable only through markers has no real kind to name.
        expect(canonical).toBe(`SyntaxKind ${value}`)
      } else {
        expect(names).toContain(canonical)
        expect(isMarkerName(canonical)).toBe(false)
      }
    }
  })
})
