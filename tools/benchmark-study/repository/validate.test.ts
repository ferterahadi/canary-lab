import { expect, it } from 'vitest'
import { parseResults } from '../evaluator'
import { assertExpectedEvidence } from './validate'

const titles = [
  'default/toon-encoded tool: content[0].text TOON-decodes back to the original array',
  "encoding:'json' tool: content[0].text is exact JSON.stringify(value)",
]

function failedReport(messages: string[]) {
  return { errors: [], suites: [{ specs: titles.map((title, index) => ({ title, tests: [{ status: 'unexpected', results: [
    { status: 'failed', error: { message: messages[index] }, errors: [{ message: messages[index] }] },
  ] }] })) }] }
}

it('rejects two infrastructure failures even when Playwright reports the expected failure count', () => {
  const report = failedReport(['Error: ECONNREFUSED during test setup', 'Error: ECONNREFUSED during test setup'])
  const evidence = parseResults(report, 1)
  expect(evidence.failed).toHaveLength(2)
  expect(() => assertExpectedEvidence('overlap', evidence, report)).toThrow('unexpected reason')
})

it('accepts the held-out overlap failure signatures and rejects a changed oracle title', () => {
  const report = failedReport([
    'Error: expect(received).toEqual(expected)\n- "row-2"',
    'Error: expect(received).toBe(expected)\nExpected: "row-2"\nReceived: "row-1"',
  ])
  expect(() => assertExpectedEvidence('overlap', parseResults(report, 1), report)).not.toThrow()
  report.suites[0].specs[0].tests[0].results[0].errors.push({ message: 'Error: ECONNRESET during afterEach' })
  expect(() => assertExpectedEvidence('overlap', parseResults(report, 1), report)).toThrow('unexpected reason')
  report.suites[0].specs[0].tests[0].results[0].errors.pop()
  report.suites[0].specs[0].title = 'unrelated test'
  expect(() => assertExpectedEvidence('overlap', parseResults(report, 1), report)).toThrow('roster or result shape')
})
