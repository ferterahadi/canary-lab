import { describe, expect, it, vi } from 'vitest'
import * as translator from '../../../../shared/readable-tests/translator'
import { renderEnglishSource } from './english'

describe('complete exported English', () => {
  it('keeps statements beyond the diagram limit and nested helper definitions', () => {
    const statements = Array.from({ length: 35 }, (_, index) => `expect(value).toBe(${index})`).join(';')
    const html = renderEnglishSource('review.spec.ts', `{ function helper() { return '<script>' }; ${statements} }`)
    expect(html).toContain('Define function helper')
    expect(html).toContain('Return &quot;&lt;script&gt;&quot;')
    expect(html).toContain('Check that value equals 34')
    expect(html.match(/Check that value equals/g)).toHaveLength(35)
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('omitted')
  })

  it('labels syntax fallbacks and distinguishes empty bodies from unavailable English', () => {
    expect(renderEnglishSource('support.ts', 'namespace Scope {}')).toContain('English incomplete')
    expect(renderEnglishSource('empty.ts', '{}')).toContain('no statements')
    expect(renderEnglishSource('empty.ts', '')).toContain('no statements')
    const translate = vi.spyOn(translator, 'translateReadableSource').mockReturnValueOnce({ steps: [] })
    try { expect(renderEnglishSource('unsupported.ts', 'future syntax')).toContain('English unavailable') }
    finally { translate.mockRestore() }
  })
})
