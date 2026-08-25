import { describe, expect, it } from 'vitest'
import {
  applyPersonalWikiBlock,
  PERSONAL_WIKI_END,
  PERSONAL_WIKI_START,
  renderPersonalWikiBlock,
  renderPersonalWikiMap,
} from './personal-wiki'

describe('personal wiki rendering', () => {
  it('renders a concise map entry for configured wiki paths', () => {
    expect(renderPersonalWikiMap('/Users/dev/Documents/wiki')).toBe(
      '- `/Users/dev/Documents/wiki` — Karpathy-style personal wiki: distilled prior agent sessions as cross-linked markdown, LLM-curated and append-only. Look for an index/home/readme file at the root as a TOC; notes use `[[wikilinks]]` — follow links rather than re-grepping. Consult when the current failure seems related to prior work.',
    )
  })

  it('renders empty map content for missing paths', () => {
    expect(renderPersonalWikiMap(null)).toBe('')
    expect(renderPersonalWikiMap('')).toBe('')
    expect(renderPersonalWikiBlock(null)).toBe(`${PERSONAL_WIKI_START}\n${PERSONAL_WIKI_END}`)
  })

  it('updates only the personal wiki block body', () => {
    const existing = [
      'before',
      PERSONAL_WIKI_START,
      '- old',
      PERSONAL_WIKI_END,
      'after',
    ].join('\n')

    expect(applyPersonalWikiBlock(existing, '/tmp/wiki')).toBe([
      'before',
      PERSONAL_WIKI_START,
      '- `/tmp/wiki` — Karpathy-style personal wiki: distilled prior agent sessions as cross-linked markdown, LLM-curated and append-only. Look for an index/home/readme file at the root as a TOC; notes use `[[wikilinks]]` — follow links rather than re-grepping. Consult when the current failure seems related to prior work.',
      PERSONAL_WIKI_END,
      'after',
    ].join('\n'))
  })

  it('leaves content without the markers untouched', () => {
    // No block to update: writing one would append agent instructions to a
    // file that never opted in, so the content has to pass through verbatim.
    const plain = 'a doc that never had a wiki block\n'
    expect(applyPersonalWikiBlock(plain, '/tmp/wiki')).toBe(plain)
  })

  it('leaves content whose end marker precedes its start marker untouched', () => {
    const inverted = [PERSONAL_WIKI_END, 'stray', PERSONAL_WIKI_START].join('\n')
    expect(applyPersonalWikiBlock(inverted, '/tmp/wiki')).toBe(inverted)
  })
})
