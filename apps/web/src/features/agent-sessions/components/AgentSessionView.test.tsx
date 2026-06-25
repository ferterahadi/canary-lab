// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Markdown } from './AgentSessionView'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('Markdown (agent session prose)', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  const render = (text: string): void => {
    act(() => root.render(<Markdown text={text} />))
  }

  it('renders GFM tables as a real <table>', () => {
    render('| Construct | Action |\n| --- | --- |\n| listener | portified |')
    const table = container.querySelector('table')
    expect(table).not.toBeNull()
    expect(container.querySelectorAll('th')).toHaveLength(2)
    expect(container.querySelector('td')?.textContent).toBe('listener')
  })

  it('renders headings, bold, and inline code as elements (not raw syntax)', () => {
    render('## Findings\n\nThe **only** listener uses `process.env.PORT`.')
    expect(container.querySelector('h2')?.textContent).toBe('Findings')
    expect(container.querySelector('strong')?.textContent).toBe('only')
    expect(container.querySelector('code')?.textContent).toBe('process.env.PORT')
    // No literal markdown tokens leak into the rendered text.
    expect(container.textContent).not.toContain('##')
    expect(container.textContent).not.toContain('**')
  })

  it('does not render raw HTML embedded in the markdown', () => {
    render('Hello <img src=x onerror="alert(1)"> world')
    expect(container.querySelector('img')).toBeNull()
  })
})
