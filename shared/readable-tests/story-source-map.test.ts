import { describe, expect, it } from 'vitest'
import {
  readableStorySequenceEntries,
  storyCodeLineNumbers,
  storyItemIdForSourceLine,
  storyLocalSequenceLabel,
  storySequenceLabel,
} from './story-source-map'
import type { ReadableStoryFlow, ReadableStoryItem, ReadableStoryStep } from './types'

const FILE = '/repo/e2e/checkout.spec.ts'

function step(id: string, startLine: number, endLine = startLine, file = FILE): ReadableStoryStep {
  return { id, role: 'action', text: id, spans: [{ text: id }], fidelity: 'derived', source: { file, startLine, endLine, snippet: id } }
}

function flow(id: string, startLine: number, endLine: number, children: ReadableStoryItem[]): ReadableStoryFlow {
  return { id, kind: 'flow', flowKind: 'scope', role: 'setup', text: id, spans: [{ text: id }], fidelity: 'derived', source: { file: FILE, startLine, endLine, snippet: id }, children }
}

describe('sequence labels', () => {
  it('pads the top level to two digits and leaves nested parts bare', () => {
    expect(storySequenceLabel([1])).toBe('01')
    expect(storySequenceLabel([12, 3, 4])).toBe('12.3.4')
    expect(storyLocalSequenceLabel([3])).toBe('03')
    expect(storyLocalSequenceLabel([1, 2])).toBe('2')
  })

  it('flattens flows in authored order, each entry carrying both labels', () => {
    const entries = readableStorySequenceEntries([step('a', 1), flow('f', 2, 5, [step('b', 3), step('c', 4)]), step('d', 6)])
    expect(entries.map((entry) => [entry.item.id, entry.sequenceLabel, entry.localSequenceLabel])).toEqual([
      ['a', '01', '01'],
      ['f', '02', '02'],
      ['b', '02.1', '1'],
      ['c', '02.2', '2'],
      ['d', '03', '03'],
    ])
  })
})

describe('storyItemIdForSourceLine', () => {
  const steps = [flow('outer', 10, 20, [flow('inner', 12, 16, [step('leaf', 13)]), step('wide', 17, 19), step('narrow', 18)])]

  it('ignores rows outside every range and rows in another file', () => {
    expect(storyItemIdForSourceLine(steps, FILE, 9)).toBeUndefined()
    expect(storyItemIdForSourceLine(steps, FILE, 21)).toBeUndefined()
    expect(storyItemIdForSourceLine([step('helper', 10, 20, '/repo/helpers.ts')], FILE, 12)).toBeUndefined()
  })

  it('prefers the deepest row, then the narrowest range at equal depth', () => {
    expect(storyItemIdForSourceLine(steps, FILE, 10)).toBe('outer')
    expect(storyItemIdForSourceLine(steps, FILE, 12)).toBe('inner')
    expect(storyItemIdForSourceLine(steps, FILE, 13)).toBe('leaf')
    expect(storyItemIdForSourceLine(steps, FILE, 17)).toBe('wide')
    expect(storyItemIdForSourceLine(steps, FILE, 18)).toBe('narrow')
  })

  it('keeps the first of two equally specific rows whichever order they are authored in', () => {
    expect(storyItemIdForSourceLine([step('first', 5), step('second', 5)], FILE, 5)).toBe('first')
    expect(storyItemIdForSourceLine([step('wider', 4, 6), step('narrower', 5)], FILE, 5)).toBe('narrower')
    expect(storyItemIdForSourceLine([step('narrower', 5), step('wider', 4, 6)], FILE, 5)).toBe('narrower')
  })
})

describe('storyCodeLineNumbers', () => {
  it('numbers only rows inside the visible range and in the listed file', () => {
    const steps = [step('before', 1), step('shown', 5), step('after', 9), step('elsewhere', 6, 6, '/repo/helpers.ts')]
    expect([...storyCodeLineNumbers(steps, FILE, 4, 8)]).toEqual([[5, { sequence: '02', label: '02' }]])
  })

  it('clamps a block that starts above the visible range to the first visible row', () => {
    const steps = [flow('block', 2, 8, [step('child', 4)])]
    expect([...storyCodeLineNumbers(steps, FILE, 3, 8)]).toEqual([
      [3, { sequence: '01', label: '01' }],
      [4, { sequence: '01.1', label: '1' }],
    ])
  })

  it('lets the deeper, then the narrower, row own a shared line', () => {
    const shared = [flow('parent', 10, 12, [step('child', 10)])]
    expect(storyCodeLineNumbers(shared, FILE, 10, 12).get(10)).toEqual({ sequence: '01.1', label: '1' })
    const siblings = [step('wide', 20, 22), step('narrow', 20), step('wide-again', 20, 24)]
    expect(storyCodeLineNumbers(siblings, FILE, 20, 24).get(20)).toEqual({ sequence: '02', label: '02' })
  })
})
