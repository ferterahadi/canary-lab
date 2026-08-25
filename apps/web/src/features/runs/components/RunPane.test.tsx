import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RUN_PANE_BAR_HEIGHT, RunPane } from './RunPane'
import { healEmptyCopy } from './RunDetailColumn'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  root.unmount()
  container.remove()
})

describe('RunPane', () => {
  it('renders no chrome of its own when the pane has no sub-tabs', async () => {
    await act(async () => {
      root.render(<RunPane padded>body</RunPane>)
    })
    // The tab the user clicked already names the pane — a title bar here would
    // repeat it and push the content down for nothing.
    expect(container.querySelector('.cl-panel-header')).toBeNull()
    expect(container.textContent).toBe('body')
  })

  it('renders a fixed-height rail for the panes that do have sub-tabs', async () => {
    await act(async () => {
      root.render(<RunPane bar={<button type="button">Playback</button>}>body</RunPane>)
    })
    const bar = container.querySelector('.cl-panel-header')
    expect(bar?.className).toContain(RUN_PANE_BAR_HEIGHT)
    expect(bar?.textContent).toBe('Playback')
  })

  it('scrolls its content with a stable gutter so a growing pane does not shift sideways', async () => {
    await act(async () => {
      root.render(<RunPane padded>body</RunPane>)
    })
    const scroller = container.firstElementChild?.firstElementChild as HTMLElement
    expect(scroller.style.scrollbarGutter).toBe('stable')
    expect(scroller.className).toContain('p-4')
  })
})

describe('healEmptyCopy', () => {
  it('reads a passing run with no cycles as a good outcome, not a missing file', () => {
    const copy = healEmptyCopy('passed', 0)
    expect(copy.tone).toBe('good')
    expect(copy.title).toBe('No repairs needed')
  })

  it('distinguishes a run that never reached a repair cycle', () => {
    expect(healEmptyCopy('aborted', 0)).toMatchObject({ title: 'No repair agent ran', tone: 'neutral' })
  })

  it('names the cycle count when the transcript itself is missing', () => {
    expect(healEmptyCopy('failed', 1).body).toContain('1 repair cycle')
    expect(healEmptyCopy('failed', 3).body).toContain('3 repair cycles')
  })
})
