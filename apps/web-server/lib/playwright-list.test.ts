import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  listPlaywrightTests,
  clearPlaywrightListCache,
  type PlaywrightListSpawner,
} from './playwright-list'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-pwl-')))
  clearPlaywrightListCache()
})

function jsonSpawner(payload: unknown): PlaywrightListSpawner {
  return (cwd) => ({
    command: 'node',
    args: ['-e', `process.stdout.write(${JSON.stringify(JSON.stringify(payload))})`],
    cwd,
  })
}

function stderrFailSpawner(): PlaywrightListSpawner {
  return (cwd) => ({
    command: 'node',
    args: ['-e', 'process.stderr.write("boom"); process.exit(2)'],
    cwd,
  })
}

function bogusJsonSpawner(): PlaywrightListSpawner {
  return (cwd) => ({
    command: 'node',
    args: ['-e', 'process.stdout.write("not json")'],
    cwd,
  })
}

function notFoundSpawner(): PlaywrightListSpawner {
  return (cwd) => ({
    command: '/definitely/does/not/exist/playwright-binary',
    args: [],
    cwd,
  })
}

function sleepSpawner(): PlaywrightListSpawner {
  return (cwd) => ({
    command: 'node',
    args: ['-e', 'setTimeout(() => process.exit(0), 5000)'],
    cwd,
  })
}

describe('listPlaywrightTests', () => {
  it('parses suites + nested suites and resolves relative file paths', async () => {
    const e2e = path.join(tmpDir, 'e2e')
    fs.mkdirSync(e2e, { recursive: true })
    fs.writeFileSync(path.join(e2e, 'a.spec.ts'), '// ok')
    const entries = await listPlaywrightTests(tmpDir, {
      spawner: jsonSpawner({
        config: { rootDir: tmpDir },
        suites: [
          {
            file: 'e2e/a.spec.ts',
            specs: [{ title: 'top', line: 1 }],
            suites: [
              {
                file: 'e2e/a.spec.ts',
                specs: [{ title: 'nested', line: 5 }],
              },
            ],
          },
        ],
      }),
    })
    expect(entries).not.toBeNull()
    expect(entries!.map((e) => e.title).sort()).toEqual(['nested', 'top'])
    expect(entries!.every((e) => path.isAbsolute(e.file))).toBe(true)
  })

  it('skips specs with missing title or line', async () => {
    const entries = await listPlaywrightTests(tmpDir, {
      spawner: jsonSpawner({
        config: { rootDir: tmpDir },
        suites: [
          {
            file: 'spec.ts',
            specs: [
              { title: 'good', line: 3 },
              { title: 'no-line' },
              { line: 5 },
            ],
          },
          { specs: [{ title: 'no-file', line: 1 }] },
        ],
      }),
    })
    expect(entries!.map((e) => e.title)).toEqual(['good'])
  })

  it('returns null when JSON is invalid', async () => {
    expect(await listPlaywrightTests(tmpDir, { spawner: bogusJsonSpawner() })).toBeNull()
  })

  it('returns null when the spawn exits non-zero (with stderr)', async () => {
    expect(await listPlaywrightTests(tmpDir, { spawner: stderrFailSpawner() })).toBeNull()
  })

  it('returns null when the command cannot be spawned', async () => {
    expect(await listPlaywrightTests(tmpDir, { spawner: notFoundSpawner() })).toBeNull()
  })

  it('returns null when the spawn exceeds the timeout', async () => {
    expect(
      await listPlaywrightTests(tmpDir, { spawner: sleepSpawner(), timeoutMs: 50 }),
    ).toBeNull()
  })

  it('caches results by feature dir signature', async () => {
    const e2e = path.join(tmpDir, 'e2e')
    fs.mkdirSync(e2e, { recursive: true })
    fs.writeFileSync(path.join(e2e, 'a.spec.ts'), '// 1')
    let calls = 0
    const spy: PlaywrightListSpawner = (cwd) => {
      calls++
      return jsonSpawner({ config: { rootDir: cwd }, suites: [] })(cwd)
    }
    await listPlaywrightTests(tmpDir, { spawner: spy })
    await listPlaywrightTests(tmpDir, { spawner: spy })
    expect(calls).toBe(1)
  })

  it('walks suites that have only nested suites (no direct specs)', async () => {
    const entries = await listPlaywrightTests(tmpDir, {
      spawner: jsonSpawner({
        config: { rootDir: tmpDir },
        suites: [
          {
            file: 'spec.ts',
            // no `specs` field — must descend into `suites`
            suites: [{ file: 'spec.ts', specs: [{ title: 'deep', line: 1 }] }],
          },
        ],
      }),
    })
    expect(entries!.map((e) => e.title)).toEqual(['deep'])
  })

  it('signature handles missing e2e directory', async () => {
    const entries = await listPlaywrightTests(tmpDir, {
      spawner: jsonSpawner({ config: { rootDir: tmpDir }, suites: [] }),
    })
    expect(entries).toEqual([])
  })

  it('falls back to featureDir when report.config.rootDir is missing', async () => {
    const entries = await listPlaywrightTests(tmpDir, {
      spawner: jsonSpawner({
        suites: [{ file: 'spec.ts', specs: [{ title: 't', line: 1 }] }],
      }),
    })
    expect(entries![0].file).toBe(path.resolve(tmpDir, 'spec.ts'))
  })
})
