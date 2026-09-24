import { discoveryFailureOutput } from './playwright-list'
import { describe, it, expect, beforeEach, vi } from 'vitest'
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

  it('logs the discovery failure from stdout, not the package runner banner on stderr', async () => {
    // The banner is load-bearing: npm 12 writes `npm notice run ...` to
    // stderr for every `npx`, so a console line that echoed stderr reported
    // the banner instead of the failure — the same text for every feature.
    const report = { config: { workers: 20 }, errors: [{ message: "Cannot find module './fixture'" }] }
    const spawner: PlaywrightListSpawner = (cwd) => ({
      command: 'node',
      args: ['-e', `process.stderr.write('npm notice run pkg@0.1.0 npx'); process.stdout.write(${JSON.stringify(JSON.stringify(report))}); process.exit(1)`],
      cwd,
    })
    const written: string[] = []
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => { written.push(String(chunk)); return true })
    let diagnostic = ''
    try {
      expect(await listPlaywrightTests(tmpDir, { spawner, onDiagnostics: (text) => { diagnostic = text } })).toBeNull()
    } finally {
      spy.mockRestore()
    }
    const line = written.find((text) => text.startsWith('[playwright-list]'))
    expect(line).toContain("Cannot find module './fixture'")
    expect(line).toContain(tmpDir)
    expect(line).not.toContain('npm notice')
    expect(diagnostic).toContain("Cannot find module './fixture'")
  })

  it('stays silent on the console when a non-zero exit produced no output at all', async () => {
    // Nothing to report is not the same as a failure worth a console line.
    const spawner: PlaywrightListSpawner = (cwd) => ({ command: 'node', args: ['-e', 'process.exit(3)'], cwd })
    const written: string[] = []
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => { written.push(String(chunk)); return true })
    try {
      expect(await listPlaywrightTests(tmpDir, { spawner })).toBeNull()
    } finally {
      spy.mockRestore()
    }
    expect(written.some((text) => text.startsWith('[playwright-list]'))).toBe(false)
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

  it('fresh verification bypasses and invalidates a cached success when dependencies break', async () => {
    const success = jsonSpawner({ config: { rootDir: tmpDir }, suites: [
      { file: 'case.spec.ts', specs: [{ title: 'preserved case', line: 1 }] },
    ] })
    expect(await listPlaywrightTests(tmpDir, { spawner: success })).toHaveLength(1)
    // A missing dependency need not change any spec file's signature.
    expect(await listPlaywrightTests(tmpDir, { spawner: stderrFailSpawner(), fresh: true })).toBeNull()
    expect(await listPlaywrightTests(tmpDir, { spawner: stderrFailSpawner() })).toBeNull()
    expect(await listPlaywrightTests(tmpDir, { spawner: success, fresh: true })).toHaveLength(1)
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

  it('attributes helper-defined tests to the outermost (entry-point) spec file', async () => {
    // Simulates Playwright's report when a spec just imports a helper that
    // calls `test(...)`. Top-level suite is the spec the runner loaded;
    // inner suite + specs report the helper's location. The entry's `file`
    // must be the spec (so bucketing keeps the test under it), while
    // `originFile`/`originLine` must point at the helper.
    const entries = await listPlaywrightTests(tmpDir, {
      spawner: jsonSpawner({
        config: { rootDir: tmpDir },
        suites: [
          {
            file: 'e2e/hk-en-alipay.spec.ts',
            suites: [
              {
                file: 'e2e/helpers/spec-factory.ts',
                title: 'en_HK matrix',
                specs: [
                  { title: 'en_HK: main page', file: 'e2e/helpers/spec-factory.ts', line: 54 },
                  { title: 'en_HK: checkout', file: 'e2e/helpers/spec-factory.ts', line: 58 },
                ],
              },
            ],
          },
        ],
      }),
    })
    expect(entries).not.toBeNull()
    expect(entries).toHaveLength(2)
    for (const e of entries!) {
      expect(e.file).toBe(path.resolve(tmpDir, 'e2e/hk-en-alipay.spec.ts'))
      expect(e.originFile).toBe(path.resolve(tmpDir, 'e2e/helpers/spec-factory.ts'))
    }
    expect(entries![0].originLine).toBe(54)
    expect(entries![1].originLine).toBe(58)
  })

  it('keeps originFile === file for direct test() calls', async () => {
    const entries = await listPlaywrightTests(tmpDir, {
      spawner: jsonSpawner({
        config: { rootDir: tmpDir },
        suites: [
          {
            file: 'e2e/direct.spec.ts',
            specs: [{ title: 'plain', line: 4 }],
          },
        ],
      }),
    })
    const entry = entries![0]
    expect(entry.file).toBe(entry.originFile)
    expect(entry.line).toBe(entry.originLine)
  })

  it('falls back to the spec-level file when no ancestor suite carries a file', async () => {
    // The suite itself has no `file` (so `nextRoot` stays undefined through
    // the whole ancestor chain), but the spec carries its own `file`. This
    // exercises the right-hand side of `const entryRaw = nextRoot ?? originRaw`:
    // with no ancestor file to fall back to, the entry's `file` must resolve
    // to the spec's own file, same as `originFile`.
    const entries = await listPlaywrightTests(tmpDir, {
      spawner: jsonSpawner({
        config: { rootDir: tmpDir },
        suites: [
          {
            specs: [{ title: 'solo', line: 7, file: 'e2e/spec-own.spec.ts' }],
          },
        ],
      }),
    })
    expect(entries).not.toBeNull()
    expect(entries).toHaveLength(1)
    const entry = entries![0]
    expect(entry.file).toBe(path.resolve(tmpDir, 'e2e/spec-own.spec.ts'))
    expect(entry.originFile).toBe(path.resolve(tmpDir, 'e2e/spec-own.spec.ts'))
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


describe('discoveryFailureOutput', () => {
  it('surfaces the Playwright error messages without burying them under the config dump', () => {
    const report = { config: { workers: 20 }, errors: [{ message: "Cannot find module './fixture'" }, { message: 'No tests found' }, null] }
    expect(discoveryFailureOutput(JSON.stringify(report), 'npm notice')).toBe("Cannot find module './fixture'\n\nNo tests found")
  })
  it('preserves bounded raw diagnostics when the output has no structured errors', () => {
    for (const stdout of ['compile failed', 'null', '{"errors":[{}]}']) expect(discoveryFailureOutput(stdout, 'stderr')).toBe(`stderr\n${stdout}`)
    expect(discoveryFailureOutput('x'.repeat(10000), '')).toHaveLength(8000)
  })
})
