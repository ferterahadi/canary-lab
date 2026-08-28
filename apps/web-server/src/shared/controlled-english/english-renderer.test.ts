import { describe, expect, it } from 'vitest'
import { ENGLISH_INDENT, isInline, renderEnglish, renderInline, renderLines, renderSummary } from './english-renderer'
import { atom, clause, isVerbNode, seq } from './ir'

const name = (text: string) => atom('name', text)

describe('isInline', () => {
  it('treats atoms and all-inline seqs as inline', () => {
    expect(isInline(name('`a`'))).toBe(true)
    expect(isInline(seq('binary', [name('`a`'), atom('operator', 'plus'), name('`b`')]))).toBe(true)
  })

  it('a seq is block as soon as one part is block', () => {
    const block = clause('statements', [{ label: '', child: name('`a`') }], 'block')
    expect(isInline(seq('phrase', [name('`x`'), block]))).toBe(false)
  })

  it('layout: block pins a clause even when every segment is inline', () => {
    expect(isInline(clause('call', [{ label: 'call', child: name('`f`') }], 'block'))).toBe(false)
  })

  it('a separate segment forces block layout', () => {
    expect(isInline(clause('return', [{ label: 'return', child: name('`x`'), separate: true }]))).toBe(false)
  })

  it('a list is inline only when every item is an atom', () => {
    const atoms = clause('union-type', [{ label: 'union type of', list: [name('string'), name('null')] }])
    const structured = clause('union-type', [
      { label: 'union type of', list: [name('string'), seq('type-operator', [atom('operator', 'the keys of'), name('`T`')])] },
    ])
    expect(isInline(atoms)).toBe(true)
    expect(isInline(structured)).toBe(false)
  })
})

describe('renderInline', () => {
  it('joins seq parts with single spaces', () => {
    expect(renderInline(seq('not', [atom('operator', 'not'), name('`ready`')]))).toBe('not `ready`')
  })

  it('joins inline list items as prose with a final and', () => {
    const one = clause('t', [{ label: 'of', list: [name('a')] }])
    const two = clause('t', [{ label: 'of', list: [name('a'), name('b')] }])
    const three = clause('t', [{ label: 'of', list: [name('a'), name('b'), name('c')] }])
    expect(renderInline(one)).toBe('of a')
    expect(renderInline(two)).toBe('of a and b')
    expect(renderInline(three)).toBe('of a, b and c')
  })

  it('renders a bare label, a label-less child, and an empty list label', () => {
    expect(renderInline(clause('t', [{ label: 'with no arguments' }]))).toBe('with no arguments')
    expect(renderInline(clause('t', [{ label: '', child: name('`x`') }]))).toBe('`x`')
    expect(renderInline(clause('t', [{ label: 'members', list: [] }]))).toBe('members')
  })
})

describe('renderLines', () => {
  it('renders an inline node as one padded line', () => {
    expect(renderLines(name('`a`'), 2)).toEqual([`${ENGLISH_INDENT.repeat(2)}\`a\``])
  })

  it('renders a block seq as consecutive lines at the same depth', () => {
    const block = clause('call', [{ label: 'call', child: name('`f`') }], 'block')
    const phrase = seq('non-null', [block, atom('label', 'asserted non-null')])
    expect(renderLines(phrase)).toEqual(['call `f`', 'asserted non-null'])
  })

  it('keeps an inline child on its label line inside a block clause', () => {
    const node = clause('if', [{ label: 'if', child: name('`ready`') }, { label: 'then', child: name('continue'), separate: true }], 'block')
    expect(renderLines(node)).toEqual(['if `ready`', 'then:', `${ENGLISH_INDENT}continue`])
  })

  it('indents a labelled block child under its label', () => {
    const inner = clause('statements', [{ label: '', child: name('`a`') }, { label: '', child: name('`b`') }], 'block')
    const node = clause('block', [{ label: 'body', child: inner }], 'block')
    expect(renderLines(node)).toEqual(['body:', `${ENGLISH_INDENT}\`a\``, `${ENGLISH_INDENT}\`b\``])
  })

  it('continues a label-less block child at the clause depth', () => {
    const inner = clause('call', [{ label: 'call', child: name('`f`') }], 'block')
    const node = clause('labeled', [{ label: 'labeled', child: name('`outer`') }, { label: '', child: inner }], 'block')
    expect(renderLines(node)).toEqual(['labeled `outer`', 'call `f`'])
  })

  it('renders an empty list as its bare label and a filled list one item per line', () => {
    const empty = clause('class', [{ label: 'with no members', list: [] }], 'block')
    expect(renderLines(empty)).toEqual(['with no members'])
    const filled = clause('class', [{ label: 'members', list: [name('`a`'), name('`b`')] }], 'block')
    expect(renderLines(filled)).toEqual(['members:', `${ENGLISH_INDENT}\`a\``, `${ENGLISH_INDENT}\`b\``])
  })

  it('renders a bare label segment as its own line', () => {
    const node = clause('yield', [{ label: 'yield' }], 'block')
    expect(renderLines(node)).toEqual(['yield'])
  })
})

describe('renderEnglish and renderSummary', () => {
  it('joins lines with newlines', () => {
    const node = clause('t', [{ label: 'a' }, { label: 'b' }], 'block')
    expect(renderEnglish(node)).toBe('a\nb')
  })

  it('summarizes an inline node as its full text', () => {
    expect(renderSummary(seq('not', [atom('operator', 'not'), name('`x`')]))).toBe('not `x`')
  })

  it('summarizes a block node as its first line marked elided', () => {
    const node = clause('call', [{ label: 'call', child: name('`f`') }, { label: 'with argument', child: name('`a`') }], 'block')
    expect(renderSummary(node)).toBe('call `f` …')
  })
})

describe('isVerbNode', () => {
  it('is true only for clauses carrying a verb tag', () => {
    expect(isVerbNode(clause('call', []))).toBe(true)
    expect(isVerbNode(clause('property-access', []))).toBe(false)
    expect(isVerbNode(atom('name', 'call'))).toBe(false)
  })
})
