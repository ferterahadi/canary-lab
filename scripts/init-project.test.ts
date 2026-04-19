import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const execFileSync = vi.fn(() => Buffer.from(''))
vi.mock('child_process', () => ({ execFileSync }))

const { main, parseArgs, copyDir, resolveFirstExisting, buildPackageJson } = await import(
  './init-project'
)

const tmpDirs: string[] = []
function mkTmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-init-'))
  tmpDirs.push(dir)
  return fs.realpathSync(dir)
}

let originalCwd: string
beforeEach(() => {
  originalCwd = process.cwd()
  execFileSync.mockReset()
  execFileSync.mockImplementation(() => Buffer.from(''))
})

afterEach(() => {
  process.chdir(originalCwd)
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('resolveFirstExisting', () => {
  it('returns the first existing candidate', () => {
    const dir = mkTmp()
    const existing = path.join(dir, 'a.txt')
    fs.writeFileSync(existing, 'x')
    const result = resolveFirstExisting([
      path.join(dir, 'missing1'),
      existing,
      path.join(dir, 'missing2'),
    ])
    expect(result).toBe(existing)
  })

  it('throws when no candidate exists', () => {
    expect(() =>
      resolveFirstExisting(['/definitely/missing/x', '/definitely/missing/y']),
    ).toThrow(/Could not resolve any expected path/)
  })
})

describe('buildPackageJson', () => {
  it('emits valid JSON ending with a newline and expected fields', () => {
    const out = buildPackageJson('my_project', '^0.6.0')
    expect(out.endsWith('\n')).toBe(true)
    const parsed = JSON.parse(out)
    expect(parsed.name).toBe('my_project')
    expect(parsed.private).toBe(true)
    expect(parsed.version).toBe('0.1.0')
    expect(parsed.scripts).toEqual({
      postinstall: 'canary-lab upgrade --silent',
      upgrade: 'canary-lab upgrade',
      'canary-lab:run': 'canary-lab run',
      'canary-lab:env': 'canary-lab env',
      'canary-lab:new-feature': 'canary-lab new-feature',
      'install:browsers': 'playwright install chromium',
    })
    expect(parsed.devDependencies).toEqual({
      '@playwright/test': '^1.54.2',
      '@types/node': '^22.0.0',
      'canary-lab': '^0.6.0',
      dotenv: '^16.6.1',
      tsx: '^4.20.3',
    })
  })

  it('passes packageSpec through verbatim for tarball/file specs', () => {
    const out = buildPackageJson('x', 'file:../canary-lab-0.6.0.tgz')
    expect(JSON.parse(out).devDependencies['canary-lab']).toBe('file:../canary-lab-0.6.0.tgz')
  })
})

describe('parseArgs', () => {
  it('defaults packageSpec to ^<version from package.json>', () => {
    const { folder, packageSpec } = parseArgs(['my-folder'])
    expect(folder).toBe('my-folder')
    expect(packageSpec).toMatch(/^\^\d+\.\d+\.\d+/)
  })

  it('overrides packageSpec with --package-spec value', () => {
    expect(parseArgs(['f', '--package-spec', 'file:../x.tgz']).packageSpec).toBe('file:../x.tgz')
  })

  it('errors and exits when folder missing', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(process, 'exit').mockImplementation(((c?: number) => {
      throw new Error(`__exit__${c}`)
    }) as never)
    expect(() => parseArgs([])).toThrow('__exit__1')
  })
})

describe('copyDir', () => {
  it('recursively copies files and subdirectories', () => {
    const src = mkTmp()
    const dst = path.join(mkTmp(), 'out')
    fs.mkdirSync(path.join(src, 'sub'), { recursive: true })
    fs.writeFileSync(path.join(src, 'a.txt'), 'A')
    fs.writeFileSync(path.join(src, 'sub', 'b.txt'), 'B')
    copyDir(src, dst)
    expect(fs.readFileSync(path.join(dst, 'a.txt'), 'utf-8')).toBe('A')
    expect(fs.readFileSync(path.join(dst, 'sub', 'b.txt'), 'utf-8')).toBe('B')
  })
})

describe('main (init-project orchestration)', () => {
  it('scaffolds into empty target: copies templates, writes package.json, runs git init', async () => {
    const workspace = mkTmp()
    process.chdir(workspace)
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['my-project', '--package-spec', '^9.9.9'])

    const target = path.join(workspace, 'my-project')
    expect(
      fs.existsSync(path.join(target, 'features', 'example_todo_api', 'feature.config.cjs')),
    ).toBe(true)

    const pkg = JSON.parse(fs.readFileSync(path.join(target, 'package.json'), 'utf-8'))
    expect(pkg.name).toBe('my-project')
    expect(pkg.devDependencies['canary-lab']).toBe('^9.9.9')

    expect(execFileSync).toHaveBeenCalledExactlyOnceWith(
      'git',
      ['init', '-q'],
      expect.objectContaining({ cwd: target, stdio: 'ignore' }),
    )
  })

  it('renames project name from "canary-lab" to "canary-lab-workspace"', async () => {
    const workspace = mkTmp()
    process.chdir(workspace)
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['canary-lab', '--package-spec', '^1.0.0'])
    const pkg = JSON.parse(
      fs.readFileSync(path.join(workspace, 'canary-lab', 'package.json'), 'utf-8'),
    )
    expect(pkg.name).toBe('canary-lab-workspace')
  })

  it('refuses to scaffold into a non-empty existing directory', async () => {
    const workspace = mkTmp()
    process.chdir(workspace)
    const busy = path.join(workspace, 'busy')
    fs.mkdirSync(busy)
    fs.writeFileSync(path.join(busy, 'existing.txt'), '')

    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(process, 'exit').mockImplementation(((c?: number) => {
      throw new Error(`__exit__${c}`)
    }) as never)
    await expect(main(['busy', '--package-spec', '^1.0.0'])).rejects.toThrow('__exit__1')
    expect(execFileSync).not.toHaveBeenCalled()
  })

  it('swallows git init failures (non-fatal)', async () => {
    execFileSync.mockImplementationOnce(() => {
      throw new Error('git not installed')
    })
    const workspace = mkTmp()
    process.chdir(workspace)
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await expect(main(['ok', '--package-spec', '^1.0.0'])).resolves.toBeUndefined()
    expect(
      fs.existsSync(path.join(workspace, 'ok', 'package.json')),
    ).toBe(true)
  })
})
