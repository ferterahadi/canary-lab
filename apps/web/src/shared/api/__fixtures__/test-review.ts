import type { TestFileReview } from '@shared/test-review'
import { readableTest } from './readable-test'

export function testFileReview(): TestFileReview {
  const before = ["import { test, expect } from '@playwright/test'", '', "test('a', async () => {", '  const x = 1', '  expect(x).toBe(1)', '  const context = x', '  expect(context).toBe(1)', '})']
  const after = [...before]
  after[4] = '  expect(x).toBe(2)'
  after[6] = '  expect(context).toBe(3)'
  return {
    file: 'e2e/a.spec.ts', currentPath: '/tmp/features/alpha/e2e/a.spec.ts', baseline: 'head',
    before: { source: before.join('\n'), tests: [{ name: 'a', line: 3, endLine: 8, readable: readableTest('a') }] },
    after: { source: after.join('\n'), tests: [{ name: 'a', line: 3, endLine: 8, readable: readableTest('a') }] },
    patch: '@@ -1,8 +1,8 @@\n' + before.flatMap((line, i) => line === after[i] ? [' ' + line] : ['-' + line, '+' + after[i]]).join('\n'),
    assessment: { verdict: 'unclassifiable', tests: [{ name: 'a', kind: 'changed', verdict: 'unclassifiable', changes: [{ kind: 'reshaped', verdict: 'unclassifiable', before: { line: 5, source: before[4], reason: 'Expected value changed' }, after: { line: 5, source: after[4], reason: 'Expected value changed' }, reason: 'Different expected values are not ordered by strength' }] }] },
  }
}

export function multilineImportReview(): TestFileReview {
  const review = testFileReview()
  const names = ['api', 'inbound', 'conversation', 'thread', 'threadRoute', 'settle', 'settleThread', 'key', 'list', 'control', 'fixture', 'signed', 'relayed', 'sqlFixture', 'cassandraFixture']
  const text = `Import ${names.join(', ')} from "./fixture"`
  const source = ["import { test, expect } from '@playwright/test'", 'import {', ...names.map((name) => `  ${name},`), '} from "./fixture";', 'function helper() {}'].join('\n')
  for (const side of ['before', 'after'] as const) review[side] = { source, tests: [], story: { steps: [{
    id: 'import', role: 'setup', text, spans: [{ text }], fidelity: 'exact',
    source: { file: review.file, startLine: 2, endLine: 18, snippet: source.split('\n').slice(1, 18).join('\n') },
  }] } }
  review.patch = ''
  review.assessment.tests = []
  return review
}
