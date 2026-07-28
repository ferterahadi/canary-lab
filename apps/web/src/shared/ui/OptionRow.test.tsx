import { describe, expect, it } from 'vitest'
import { OPTION_ROW_CLASS, OPTION_ROW_COMPACT_CLASS, optionRowStyle } from './OptionRow'

// The three pickers (flight start proposal's StageRow, the redo dialog's step
// rows, the heal-behavior modes) share this one look, so the invariants live
// here rather than being re-asserted three times in component tests.

describe('optionRowStyle', () => {
  it('paints selection with the app selected-grey and nothing else', () => {
    expect(optionRowStyle({ selected: true }).background).toBe('var(--bg-selected)')
    expect(optionRowStyle({ selected: false }).background).toBe('transparent')
  })

  it('always supplies the hairline colour, so callers need no border class', () => {
    for (const selected of [true, false]) {
      expect(optionRowStyle({ selected }).borderColor).toBe('var(--border-default)')
    }
  })

  it('gives a pointer only to a row that answers a click', () => {
    expect(optionRowStyle({ selected: false, interactive: true }).cursor).toBe('pointer')
    // Read-only rows (a fresh flight's journey preview) and an already-picked
    // heal mode swallow the click, so neither invites one.
    expect(optionRowStyle({ selected: false }).cursor).toBeUndefined()
    expect(optionRowStyle({ selected: true, interactive: false }).cursor).toBeUndefined()
  })

  it('lets blocked beat interactive — a live picker still marks its locked rows', () => {
    expect(optionRowStyle({ selected: false, disabled: true, interactive: true }).cursor)
      .toBe('not-allowed')
  })

  it('never dims a locked row — the reason line it carries must stay readable', () => {
    const style = optionRowStyle({ selected: false, disabled: true, interactive: true })
    expect(style.opacity).toBeUndefined()
  })

  it('keeps one padding utility per variant, so none fight over stylesheet order', () => {
    expect(OPTION_ROW_CLASS).toContain('py-2.5')
    expect(OPTION_ROW_CLASS).not.toContain('py-1.5')
    expect(OPTION_ROW_COMPACT_CLASS).toContain('py-1.5')
    expect(OPTION_ROW_COMPACT_CLASS).not.toContain('py-2.5')
  })
})
