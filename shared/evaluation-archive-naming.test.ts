import { describe, expect, it } from 'vitest'
import { evaluationArchiveBase, evaluationArchiveFilename, evaluationTaskFilename, safeFilename } from './evaluation-archive-naming'

describe('evaluation archive names', () => {
  it.each([
    ['Checkout Flow!', 'Checkout-Flow'],
    ['--keep.me--', 'keep.me'],
    ['  a/b:c  ', 'a-b-c'],
    ['你好', 'run'],
    ['', 'run'],
    ['///', 'run'],
  ])('uses one case-preserving segment rule for %j', (input, expected) => {
    expect(safeFilename(input)).toBe(expected)
  })

  it('uses the same canonical name for an archive and an older server response', () => {
    const task = { feature: 'Checkout Flow', runId: '///' }
    const base = evaluationArchiveBase(task.feature, task.runId)
    expect(base).toBe('canary-lab-evaluation-Checkout-Flow-run')
    expect(evaluationArchiveFilename(task.feature, task.runId)).toBe(`${base}.zip`)
    expect(evaluationTaskFilename(task)).toBe(`${base}.zip`)
  })

  it('preserves a persisted historical name instead of recomputing it', () => {
    expect(evaluationTaskFilename({
      feature: 'Checkout Flow', runId: '///', archiveBase: 'canary-lab-evaluation-Checkout-Flow-export',
    })).toBe('canary-lab-evaluation-Checkout-Flow-export.zip')
  })
})
