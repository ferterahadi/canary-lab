import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { locatorFidelity, renderLocator } from './locator'

function locatorFrom(source: string) {
  const sourceFile = ts.createSourceFile('locator.ts', `const target = ${source}`, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const statement = sourceFile.statements[0]
  if (!ts.isVariableStatement(statement)) throw new Error('Expected a variable statement')
  const locator = statement.declarationList.declarations[0].initializer
  if (!locator) throw new Error('Expected a locator initializer')
  return { locator, sourceFile }
}

function rendered(source: string) {
  const parsed = locatorFrom(source)
  return renderLocator(parsed.locator, parsed.sourceFile)
}

describe('Playwright locator edge cases', () => {
  it('preserves role state, dynamic role, hidden, and nested scope semantics', () => {
    expect(rendered("page.getByRole('button')")).toEqual({ text: 'the button', fidelity: 'derived' })
    expect(rendered("page.getByRole(role, { name: 'Pay' })")).toEqual({
      text: 'the element with role role named “Pay”',
      fidelity: 'derived',
    })
    expect(rendered('page.getByRole(role)')).toEqual({
      text: 'the element with role role',
      fidelity: 'derived',
    })
    expect(rendered("frame.getByText('Pay')")).toEqual({ text: 'the text “Pay”', fidelity: 'derived' })
    expect(rendered("page.getByRole('dialog').getByText('Pay')")).toEqual({
      text: 'the text “Pay” inside the dialog',
      fidelity: 'derived',
    })
    expect(rendered("dialog.getByRole('button', { name: 'Pay', exact: false, checked: true, disabled: false, expanded: false, pressed: true, selected: false, includeHidden: true, level: 3 })")).toEqual({
      text: 'the “Pay” button that is checked that is not disabled that is collapsed that is pressed that is not selected at level 3, including hidden elements inside dialog',
      fidelity: 'derived',
    })
    expect(rendered("page.getByRole('button', { includeHidden: false })")).toEqual({
      text: 'the button',
      fidelity: 'derived',
    })
  })

  it('keeps unsafe role options unresolved', () => {
    const sources = [
      'page.getByRole()',
      'page.getByRole(computeRole())',
      "page.getByRole('button', options)",
      "page.getByRole('button', { custom: true })",
      "page.getByRole('button', { name: computeName() })",
      "page.getByRole('button', { exact: exactValue })",
      "page.getByRole('button', { checked: checkedValue })",
      "page.getByRole('heading', { level: headingLevel })",
      "page.getByRole('button', { includeHidden: hiddenValue })",
      "page.getByRole('button', { ['name']: 'Pay' })",
      "page.getByRole('button', { ...options })",
    ]

    for (const source of sources) {
      expect(rendered(source)).toEqual({ text: source, fidelity: 'unresolved' })
    }
  })

  it('handles named locator options and unsafe scope without inventing context', () => {
    expect(rendered("makeScope().getByText('Pay')")).toEqual({ text: 'the text “Pay”', fidelity: 'derived' })
    expect(rendered("page.getByRole('button', { custom: true }).getByText('Pay')")).toEqual({
      text: "page.getByRole('button', { custom: true })",
      fidelity: 'unresolved',
    })

    const sources = [
      'page.getByLabel()',
      'page.getByText(computeText())',
      "page.getByText('Pay', options)",
      "page.getByText('Pay', { custom: true })",
      "page.getByText('Pay', { exact: exactValue })",
      "page.getByTestId('pay', { exact: true })",
      "page.getByText('Pay', { ['exact']: true })",
    ]
    for (const source of sources) {
      expect(rendered(source)).toEqual({ text: source, fidelity: 'unresolved' })
    }
  })

  it('renders positions and preserves invalid position calls as source', () => {
    expect(rendered("page.getByText('Retry').first()")).toEqual({
      text: 'the first match for the text “Retry”',
      fidelity: 'derived',
    })
    expect(rendered("page.getByText('Retry').last()")).toEqual({
      text: 'the last match for the text “Retry”',
      fidelity: 'derived',
    })
    expect(rendered("page.getByRole('button', { custom: true }).first()")).toEqual({
      text: "page.getByRole('button', { custom: true })",
      fidelity: 'unresolved',
    })
    expect(rendered('service.find().first()')).toBeUndefined()

    const sources = [
      "page.getByText('Retry').first(1)",
      "page.getByText('Retry').last(1)",
      "page.getByText('Retry').nth()",
      "page.getByText('Retry').nth(computeIndex())",
    ]
    for (const source of sources) {
      expect(rendered(source)).toEqual({ text: source, fidelity: 'unresolved' })
    }
  })

  it('rejects non-locators and normalizes exported fidelity', () => {
    expect(rendered('page')).toBeUndefined()
    expect(rendered('getLocator()')).toBeUndefined()
    expect(rendered('service.findAccount()')).toBeUndefined()
    expect(locatorFidelity({ text: 'the button', fidelity: 'exact' })).toBe('derived')
    expect(locatorFidelity({ text: 'source()', fidelity: 'unresolved' })).toBe('unresolved')
  })
})
