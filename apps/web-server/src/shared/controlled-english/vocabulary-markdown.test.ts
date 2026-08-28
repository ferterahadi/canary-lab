import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { renderVocabularyMarkdown } from '../../../../../tools/controlled-english-vocabulary-markdown'

describe('controlled-English vocabulary document', () => {
  it('matches the canonical machine-readable tables byte for byte', () => {
    const document = readFileSync(
      resolve(process.cwd(), 'docs/controlled-english/typescript-ast-vocabulary.md'),
      'utf8',
    )
    expect(document).toBe(renderVocabularyMarkdown())
  })
})
