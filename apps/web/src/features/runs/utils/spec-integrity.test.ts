import { describe, expect, it } from 'vitest'
import type { DirtySpecSummary, Feature } from '@/shared/api/types'
import { SPEC_TONE, featureTone, pendingFileScope, specTone, worstTone } from './spec-integrity'

function spec(verdict?: 'weaker' | 'equivalent' | 'stronger' | 'unclassifiable'): DirtySpecSummary {
  return {
    file: 'e2e/a.spec.ts',
    affectedTests: ['a'],
    ...(verdict ? { strength: { verdict, baseline: 'head', tests: [] } } : {}),
  }
}

function feature(specs: DirtySpecSummary[], status: 'clean' | 'dirty' = 'dirty'): Feature {
  return { name: 'f', description: '', repos: [], envs: [], dirty: { status, specs } } as unknown as Feature
}

describe('worstTone', () => {
  it('one weaker verdict wins over everything else', () => {
    expect(worstTone(['stronger', 'weaker', 'equivalent'])).toBe('weaker')
  })

  it('is stronger only when every verdict is stronger', () => {
    expect(worstTone(['stronger', 'stronger'])).toBe('stronger')
    expect(worstTone(['stronger', 'equivalent'])).toBe('changed')
  })

  it('reads equivalent, unclassifiable and no-verdict all as changed — none is evidence nothing weakened', () => {
    expect(worstTone(['equivalent'])).toBe('changed')
    expect(worstTone(['unclassifiable'])).toBe('changed')
    expect(worstTone([undefined])).toBe('changed')
    expect(worstTone([])).toBe('changed')
  })
})

describe('specTone / featureTone', () => {
  it('a spec with no readable verdict is changed, not equivalent', () => {
    expect(specTone(spec())).toBe('changed')
    expect(specTone(spec('weaker'))).toBe('weaker')
  })

  it('a clean suite has no tone', () => {
    expect(featureTone(feature([], 'clean'))).toBeNull()
    expect(featureTone({ name: 'f' } as unknown as Feature)).toBeNull()
  })

  it('a suite takes the worst of its specs', () => {
    expect(featureTone(feature([spec('stronger'), spec('weaker')]))).toBe('weaker')
    expect(featureTone(feature([spec('stronger')]))).toBe('stronger')
    expect(featureTone(feature([spec('stronger'), spec()]))).toBe('changed')
  })
})

describe('SPEC_TONE', () => {
  it('uses brief, human review copy while keeping the weaker signal advisory', () => {
    expect(SPEC_TONE.weaker.color).toBe('var(--warning)')
    expect(SPEC_TONE.weaker.title).toBe('Tests may be weaker than the version that ran. This hint does not change the result. AI-only, blind-checked review: 2.4% false positives.')
    expect(SPEC_TONE.changed.title).toBe('Tests changed after the run. Review before relying on this result.')
    expect(SPEC_TONE.stronger.title).toBe('Tests look stronger than the version that ran. Review and commit the changes.')
    expect(SPEC_TONE.changed.color).not.toContain('danger')
    expect(SPEC_TONE.stronger.color).toBe('var(--text-secondary)')
  })

  it('pairs advisory glyphs with distinct text labels', () => {
    expect([SPEC_TONE.weaker.glyph, SPEC_TONE.changed.glyph, SPEC_TONE.stronger.glyph]).toEqual(['!', '~', '↑'])
  })
})

describe('pendingFileScope', () => {
  it('counts the affected tests of a spec', () => {
    expect(pendingFileScope({ file: 'e2e/a.spec.ts', affectedTests: ['a'] })).toBe('1 test')
    expect(pendingFileScope({ file: 'e2e/a.spec.ts', affectedTests: ['a', 'b'] })).toBe('2 tests')
    expect(pendingFileScope({ file: 'e2e/a.spec.ts', affectedTests: [] })).toBe('0 tests')
  })

  it('names the robustness envelope for what it is rather than as zero tests', () => {
    expect(pendingFileScope({ file: 'robustness/envelope.json', affectedTests: [] })).toBe('perturbation envelope')
  })
})
