import { describe, it, expect, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { slugify, withLogMarkers } from './log-marker-fixture'

const tmpDirs: string[] = []
function mkTmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-lm-'))
  tmpDirs.push(dir)
  return fs.realpathSync(dir)
}

afterEach(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true })
})

describe('slugify (log-marker-fixture)', () => {
  it('lowercases and replaces non-alphanumeric runs with a single dash', () => {
    expect(slugify('Test: edge CASE')).toBe('test-edge-case')
  })
  it('trims leading/trailing dashes', () => {
    expect(slugify('-foo-')).toBe('foo')
  })
})

describe('withLogMarkers', () => {
  it('no-ops when manifest is missing (run still invoked)', async () => {
    let ran = false
    await withLogMarkers('a test', '/does/not/exist.json', async () => {
      ran = true
    })
    expect(ran).toBe(true)
  })

  it('wraps run() output with open/close tags in each service log from manifest', async () => {
    const dir = mkTmp()
    const logA = path.join(dir, 'a.log')
    const logB = path.join(dir, 'b.log')
    fs.writeFileSync(logA, 'pre-a\n')
    fs.writeFileSync(logB, 'pre-b\n')
    const manifestPath = path.join(dir, 'manifest.json')
    fs.writeFileSync(manifestPath, JSON.stringify({ serviceLogs: [logA, logB] }))

    await withLogMarkers('My Case', manifestPath, async () => {
      fs.appendFileSync(logA, 'during-a\n')
      fs.appendFileSync(logB, 'during-b\n')
    })

    expect(fs.readFileSync(logA, 'utf-8')).toBe(
      'pre-a\n<test-case-my-case>\nduring-a\n</test-case-my-case>\n',
    )
    expect(fs.readFileSync(logB, 'utf-8')).toBe(
      'pre-b\n<test-case-my-case>\nduring-b\n</test-case-my-case>\n',
    )
  })

  it('skips close tag when run() throws (current behavior — no try/finally)', async () => {
    const dir = mkTmp()
    const log = path.join(dir, 's.log')
    fs.writeFileSync(log, '')
    const manifestPath = path.join(dir, 'manifest.json')
    fs.writeFileSync(manifestPath, JSON.stringify({ serviceLogs: [log] }))

    await expect(
      withLogMarkers('oops', manifestPath, async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')

    expect(fs.readFileSync(log, 'utf-8')).toBe('<test-case-oops>\n')
  })
})
