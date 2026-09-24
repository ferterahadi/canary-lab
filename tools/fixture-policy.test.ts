import { describe, expect, it } from 'vitest'
import { isFixturePath, personalFixturePathLines } from './fixture-policy.mjs'

describe('repository fixture policy', () => {
  it('recognizes fixture directories without treating fixture helpers or test filenames as data directories', () => {
    for (const file of ['apps/web/__fixtures__/run.json', 'shared/fixtures/input.jsonl', 'tools/fixtures', 'apps\\web\\__fixtures__\\run.json']) {
      expect(isFixturePath(file)).toBe(true)
    }
    for (const file of ['tools/fixture-policy.test.ts', 'shared/log-marker-fixture.ts', 'apps/fixtures-old/run.json']) {
      expect(isFixturePath(file)).toBe(false)
    }
  })

  it('rejects copied home paths in JSON, source snippets, logs, and file URLs', () => {
    for (const personalPath of ['/Users/alice/project', '/home/alice/project', 'C:\\Users\\alice\\project', 'C:/users/alice/project', '~/workspace/run.json', 'file:///Users/alice/project']) {
      expect(personalFixturePathLines(JSON.stringify({ path: personalPath }, null, 2))).toEqual([2])
      expect(personalFixturePathLines(`const file = '${personalPath}'`)).toEqual([1])
      expect(personalFixturePathLines(`Error at (${personalPath}:12)`)).toEqual([1])
    }
    expect(personalFixturePathLines('{"path":"\\/Users\\/alice\\/project"}')).toEqual([1])
    expect(personalFixturePathLines('first\n/home/alice/run.json\nlast')).toEqual([2])
  })

  it('allows portable synthetic roots, runtime placeholders, and web routes', () => {
    for (const value of ['/workspace/features/sample', '/tmp/fixture/run.json', '<featureDir>/e2e/sample.spec.ts', '/users/123', 'https://example.test/home/alice', 'https://example.test/Users/alice']) {
      expect(personalFixturePathLines(JSON.stringify({ path: value }))).toEqual([])
    }
  })
})
