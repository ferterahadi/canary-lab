import { describe, expect, it } from 'vitest'
import { computePanelWidths } from './ResizablePanels'

const panels = [
  { minWidth: 180 },
  { minWidth: 280 },
  { minWidth: 400 },
]

describe('computePanelWidths', () => {
  it('caps middle panel width so the final panel remains visible', () => {
    expect(computePanelWidths(panels, [220, 700, 500], [false, false, false], 1080)).toEqual([
      220,
      452,
      400,
    ])
  })

  it('uses actual remaining width for the final panel', () => {
    expect(computePanelWidths(panels, [220, 360, 500], [false, false, false], 1080)).toEqual([
      220,
      360,
      492,
    ])
  })
})
