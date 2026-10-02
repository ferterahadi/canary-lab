import { describe, expect, it } from 'vitest'
import { parseMappingSubmission, parseSummarySubmission } from './external-submissions'

const requirement = { title: 'Checkout', text: 'Complete checkout', pathTypes: ['happy'] }

describe('external coverage submission adapters', () => {
  it('preserves validated requirements and optional variant dimensions', () => {
    const variantDimension = { name: 'channel', values: ['web', 'mobile'] }
    expect(parseSummarySubmission({ requirements: [requirement], variantDimension })).toEqual({ ok: true, submission: { requirements: [requirement], variantDimension } })
    expect(parseSummarySubmission({ requirements: [requirement] })).toEqual({ ok: true, submission: { requirements: [requirement] } })
  })

  it('rejects malformed summaries with a useful field path or root error', () => {
    expect(parseSummarySubmission({ requirements: [] })).toMatchObject({ ok: false, error: expect.stringContaining('requirements:') })
    expect(parseSummarySubmission(null)).toMatchObject({ ok: false, error: expect.stringContaining('Invalid input') })
  })

  it('passes mapping names and unmappable names to the roster contract', () => {
    const mappings = [{ testName: 'checkout', requirements: ['R1'], pathTypes: ['happy'] }]
    expect(parseMappingSubmission({ mappings, unmappable: [{ testName: 'setup', reason: 'No requirement' }] })).toEqual({ ok: true, submission: { mappings, unmappable: ['setup'] } })
    expect(parseMappingSubmission({ mappings: [] })).toEqual({ ok: true, submission: { mappings: [], unmappable: [] } })
    expect(parseMappingSubmission({ mappings: [{ testName: 42 }] })).toMatchObject({ ok: false, error: expect.stringContaining('mappings.0.testName:') })
  })
})
