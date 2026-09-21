import { describe, expect, it } from 'vitest'
import { compileSemanticSource } from '../controlled-english/semantic-context'
import { recordSourceEnglish, sourceEnglishReceipt, sourceRepresentationGaps, sourceSyntaxFallback } from './source-representation'

describe('source representation receipts', () => {
  it('records only the actual parsed source, and deduplicates nested fallback reports', () => {
    const first = compileSemanticSource('example.ts', 'const value = 1').sourceFile
    const second = compileSemanticSource('example.ts', 'const value = 1').sourceFile
    const node = first.statements[0]
    expect(sourceEnglishReceipt(node)).toBeUndefined()
    expect(sourceRepresentationGaps(node)).toEqual([])
    expect(recordSourceEnglish(node, 'Set constant value to 1')).toBe('Set constant value to 1')
    expect(sourceEnglishReceipt(node)).toBe('Set constant value to 1')
    sourceSyntaxFallback(node, 'syntax wording')
    sourceSyntaxFallback(node, 'syntax wording again')
    expect(sourceRepresentationGaps(node)).toEqual([{ node, reason: 'syntax-fallback' }])
    expect(sourceRepresentationGaps(first)).toEqual(sourceRepresentationGaps(node))
    expect(sourceRepresentationGaps(second)).toEqual([])
    expect(sourceEnglishReceipt(second.statements[0])).toBeUndefined()
  })
})
