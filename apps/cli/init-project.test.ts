import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const execFileSync = vi.fn(() => Buffer.from(''))
const setupProject = vi.fn()
vi.mock('child_process', () => ({ execFileSync }))
vi.mock('./setup', () => ({ setup: setupProject }))

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
  setupProject.mockReset()
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
      postinstall: 'canary-lab upgrade --silent && canary-lab install-browsers',
      upgrade: 'canary-lab upgrade',
      'install:browsers': 'canary-lab install-browsers',
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

  it('parses a valid --port and leaves it undefined when absent', () => {
    expect(parseArgs(['f', '--port', '8000']).port).toBe(8000)
    expect(parseArgs(['f', '--port=8001']).port).toBe(8001)
    expect(parseArgs(['f']).port).toBeUndefined()
  })

  it('parses --no-install (default false)', () => {
    expect(parseArgs(['f']).noInstall).toBe(false)
    expect(parseArgs(['f', '--no-install']).noInstall).toBe(true)
  })

  it('errors and exits on an invalid --port', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(process, 'exit').mockImplementation(((c?: number) => {
      throw new Error(`__exit__${c}`)
    }) as never)
    expect(() => parseArgs(['f', '--port', 'abc'])).toThrow('__exit__1')
    expect(() => parseArgs(['f', '--port', '99999'])).toThrow('__exit__1')
  })

  it('errors and exits when folder missing', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(process, 'exit').mockImplementation(((c?: number) => {
      throw new Error(`__exit__${c}`)
    }) as never)
    expect(() => parseArgs([])).toThrow('__exit__1')
  })

  it('errors and exits when --package-spec has no following value', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(process, 'exit').mockImplementation(((c?: number) => {
      throw new Error(`__exit__${c}`)
    }) as never)
    expect(() => parseArgs(['folder', '--package-spec'])).toThrow('__exit__1')
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

  it('renames `gitignore` to `.gitignore` on copy (npm strips .gitignore from tarballs)', () => {
    const src = mkTmp()
    const dst = path.join(mkTmp(), 'out')
    fs.writeFileSync(path.join(src, 'gitignore'), 'node_modules\n')
    copyDir(src, dst)
    expect(fs.existsSync(path.join(dst, '.gitignore'))).toBe(true)
    expect(fs.existsSync(path.join(dst, 'gitignore'))).toBe(false)
    expect(fs.readFileSync(path.join(dst, '.gitignore'), 'utf-8')).toBe('node_modules\n')
  })
})

describe('main (init-project orchestration)', () => {
  // The scaffold's own tour says "Press Run to watch a repair". `healAgent`
  // defaults to `external` — wait for an MCP client to claim the run — so that
  // run reached HEALING and waited forever for a client nobody mentioned. Only
  // `npm run demo` worked, because its harness wrote this key itself.
  it('pins the repair agent to a CLI this machine has, alongside the port', async () => {
    const workspace = mkTmp()
    process.chdir(workspace)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await main(['agented', '--package-spec', '^9.9.9', '--port', '7401'])
    const config = JSON.parse(
      fs.readFileSync(path.join(workspace, 'agented', 'canary-lab.config.json'), 'utf-8'),
    )
    expect(config.port).toBe(7401)
    // Resolved, not hardcoded: whatever this machine has, or absent when it has
    // neither — in which case the server's own default stands.
    if (config.healAgent !== undefined) {
      expect(['claude', 'codex']).toContain(config.healAgent)
    }
  })

  it('scaffolds into empty target: copies templates, writes package.json, runs git init', async () => {
    const workspace = mkTmp()
    process.chdir(workspace)
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['my-project', '--package-spec', '^9.9.9'])

    const target = path.join(workspace, 'my-project')
    expect(fs.existsSync(path.join(target, 'demo-app', 'REQUIREMENTS.md'))).toBe(true)
    expect(fs.existsSync(path.join(target, 'demo-app', 'catalog-service', 'server.ts'))).toBe(true)
    expect(fs.existsSync(path.join(target, 'demo-app', 'inventory-service', 'server.ts'))).toBe(true)
    expect(fs.existsSync(path.join(target, 'demo-app', 'checkout-service', 'server.ts'))).toBe(true)
    expect(fs.existsSync(path.join(target, 'workflow-app', 'server.ts'))).toBe(true)
    expect(fs.existsSync(path.join(target, 'features', 'workflow-workbench', 'feature.config.cjs'))).toBe(true)
    expect(fs.existsSync(path.join(target, 'features', 'workflow-workbench', 'e2e', 'workflow.spec.ts'))).toBe(true)
    expect(
      fs.readFileSync(path.join(target, 'features', 'workflow-workbench', 'playwright.config.ts'), 'utf-8'),
    ).toContain('loadFeatureEnv(__dirname)')
    expect(fs.existsSync(path.join(target, 'features', 'workflow-workbench', 'docs', '_prd-summary.json'))).toBe(true)
    const verification = JSON.parse(
      fs.readFileSync(path.join(target, 'features', 'workflow-workbench', 'verification.configs.json'), 'utf-8'),
    )
    expect(verification.configs[0]).toMatchObject({ playwrightEnvsetId: 'production', name: 'Demo deployment' })
    expect(fs.existsSync(path.join(target, 'features', 'README.md'))).toBe(true)
    // Suite setup's figures come from a run, and a fresh scaffold has none — so
    // init seeds the recorded boot. This is also what keeps `npm run demo` and a
    // user's own init in the same state.
    expect(fs.existsSync(path.join(target, 'logs', 'runs', 'index.json'))).toBe(true)
    const seeded = JSON.parse(fs.readFileSync(path.join(target, 'logs', 'runs', 'index.json'), 'utf-8'))
    expect(seeded[0]).toMatchObject({ feature: 'storefront-journey', executionType: 'boot' })
    const seededManifest = JSON.parse(
      fs.readFileSync(path.join(target, 'logs', 'runs', seeded[0].runId, 'manifest.json'), 'utf-8'),
    )
    expect(seededManifest.services).toHaveLength(3)
    expect(seededManifest.services.every((s: { readyAt?: string }) => Boolean(s.readyAt))).toBe(true)
    // Parallel readiness reads the same way: its double-boot proof and its diff
    // live in a saved portify record, not in a file the scaffold could carry.
    const portifyIds = fs.readdirSync(path.join(target, 'logs', 'portify'))
      .filter((name) => name !== 'index.json')
    expect(portifyIds).toHaveLength(1)
    const portify = JSON.parse(
      fs.readFileSync(path.join(target, 'logs', 'portify', portifyIds[0], 'portify.json'), 'utf-8'),
    )
    expect(portify).toMatchObject({ feature: 'storefront-journey', status: 'saved' })
    expect(portify.verification.instances).toHaveLength(2)
    expect(portify.verification.instances.every((i: { ok: boolean }) => i.ok)).toBe(true)
    // The record ships workspace-RELATIVE paths (a published tarball can carry
    // no machine path); init resolves them onto this workspace, or the Ports tab
    // and the config drill-through point at directories that don't exist.
    for (const p of [portify.featureDir, ...portify.repos.map((r: { path: string }) => r.path)]) {
      expect(path.isAbsolute(p)).toBe(true)
      expect(fs.existsSync(p)).toBe(true)
    }
    expect(fs.existsSync(path.join(target, 'features', 'demo_catalog'))).toBe(false)
    expect(fs.existsSync(path.join(target, 'features', 'demo_inventory'))).toBe(false)

    const pkg = JSON.parse(fs.readFileSync(path.join(target, 'package.json'), 'utf-8'))
    expect(pkg.name).toBe('my-project')
    expect(pkg.devDependencies['canary-lab']).toBe('^9.9.9')

    expect(execFileSync).toHaveBeenCalledWith(
      'git',
      ['init', '-q'],
      expect.objectContaining({ cwd: target, stdio: 'ignore' }),
    )
    expect(execFileSync).toHaveBeenCalledWith(
      'npm',
      ['install'],
      expect.objectContaining({ cwd: target }),
    )
    // One install: the scaffold's postinstall pulls the browser down, so init
    // never issues a second command for it.
    expect(execFileSync.mock.calls.filter((c) => c[0] === 'npm')).toEqual([
      ['npm', ['install'], expect.objectContaining({ cwd: target })],
    ])
    // npm `install` was mocked, so node_modules/canary-lab never materialized →
    // setup runs without a cliPath override.
    expect(setupProject).toHaveBeenCalledExactlyOnceWith(
      { workspace: target, agent: 'auto', dryRun: false, force: false, implicit: true },
      {},
    )
  })

  it('--no-install skips dependency install and prints the manual steps', async () => {
    const workspace = mkTmp()
    process.chdir(workspace)
    const messages: string[] = []
    vi.spyOn(console, 'log').mockImplementation((m) => { messages.push(String(m)) })

    await main(['my-project', '--package-spec', '^9.9.9', '--no-install'])

    expect(execFileSync.mock.calls.filter((c) => c[0] === 'npm')).toEqual([])
    expect(setupProject).toHaveBeenCalledWith(
      { workspace: path.join(workspace, 'my-project'), agent: 'auto', dryRun: false, force: false, implicit: true },
      {},
    )
    expect(messages.join('\n')).toContain('npm install')
    expect(messages.join('\n')).not.toContain('npm run install:browsers')
  })

  // The install fixture must mirror a REAL npm install — a package.json carrying
  // the same `bin` the published package declares, and the file it points at. The
  // earlier version of this test wrote `dist/scripts/cli.js` and asserted against
  // that same invented path, so it passed green for a layout the build has never
  // produced while the branch under test was permanently dead in production.
  // `bin` here is read from the repo's own package.json for that reason.
  const REAL_CLI_BIN = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf-8'),
  ).bin['canary-lab'] as string

  function fakeInstall(target: string, opts: { bin?: string; writeFile?: boolean } = {}): string {
    const pkgRoot = path.join(target, 'node_modules', 'canary-lab')
    const bin = opts.bin ?? REAL_CLI_BIN
    fs.mkdirSync(pkgRoot, { recursive: true })
    fs.writeFileSync(
      path.join(pkgRoot, 'package.json'),
      JSON.stringify({ name: 'canary-lab', bin: { 'canary-lab': bin } }),
    )
    const cli = path.join(pkgRoot, bin)
    if (opts.writeFile !== false) {
      fs.mkdirSync(path.dirname(cli), { recursive: true })
      fs.writeFileSync(cli, '#!/usr/bin/env node\n')
    }
    return cli
  }

  it('registers MCP with the stable local cli path after a successful install', async () => {
    const workspace = mkTmp()
    process.chdir(workspace)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const target = path.join(workspace, 'my-project')
    let localCli = ''
    // Simulate `npm install` materializing the local install.
    execFileSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'npm' && args[0] === 'install') localCli = fakeInstall(target)
      return Buffer.from('')
    })

    await main(['my-project', '--package-spec', '^9.9.9'])

    expect(localCli).toContain(REAL_CLI_BIN)
    expect(setupProject).toHaveBeenCalledWith(
      { workspace: target, agent: 'auto', dryRun: false, force: false, implicit: true },
      { cliPath: localCli, execPath: process.execPath },
    )
  })

  // Negative control for the above: the branch must key off the file the installed
  // package's `bin` actually names. A `bin` pointing somewhere the install did not
  // put a file is the failure mode that hid for a release — registration has to
  // fall back rather than hand `setup` a path that does not exist.
  it('falls back when the installed package bin names a missing file', async () => {
    const workspace = mkTmp()
    process.chdir(workspace)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const target = path.join(workspace, 'my-project')
    execFileSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'npm' && args[0] === 'install') {
        fakeInstall(target, { bin: 'dist/scripts/cli.js', writeFile: false })
      }
      return Buffer.from('')
    })

    await main(['my-project', '--package-spec', '^9.9.9'])

    expect(setupProject).toHaveBeenCalledWith(
      { workspace: target, agent: 'auto', dryRun: false, force: false, implicit: true },
      {},
    )
  })

  it('writes the chosen port into canary-lab.config.json when --port is given', async () => {
    const workspace = mkTmp()
    process.chdir(workspace)
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['my-project', '--package-spec', '^9.9.9', '--port', '8200'])

    const config = JSON.parse(
      fs.readFileSync(path.join(workspace, 'my-project', 'canary-lab.config.json'), 'utf-8'),
    )
    expect(config.port).toBe(8200)
  })

  it('omits the port key entirely when no --port is given', async () => {
    const workspace = mkTmp()
    process.chdir(workspace)
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['my-project', '--package-spec', '^9.9.9'])

    // The file is written only when it has something to say. Without a port that
    // is the repair agent alone — and on a machine with neither CLI, nothing at
    // all, leaving the server's defaults untouched exactly as before.
    const configPath = path.join(workspace, 'my-project', 'canary-lab.config.json')
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
      expect(config.port).toBeUndefined()
      expect(Object.keys(config)).toEqual(['healAgent'])
    }
  })

  it('scaffolds gitignore rules that keep feature envset values out of git', async () => {
    const workspace = mkTmp()
    process.chdir(workspace)
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['my-project', '--package-spec', '^9.9.9'])

    const gitignore = fs.readFileSync(path.join(workspace, 'my-project', '.gitignore'), 'utf-8')
    expect(gitignore).toContain('envsets/*/*')
    expect(gitignore).toContain('features/*/envsets/*/*')
    expect(gitignore).not.toContain('!envsets/*/*')
    expect(gitignore).not.toContain('!features/*/envsets/*/*')
    expect(gitignore).not.toContain('!features/demo_')
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

  it('swallows setup failures and prints the repair command', async () => {
    setupProject.mockImplementationOnce(() => {
      throw new Error('setup failed')
    })
    const workspace = mkTmp()
    process.chdir(workspace)
    const messages: string[] = []
    vi.spyOn(console, 'log').mockImplementation((msg) => { messages.push(String(msg)) })

    await expect(main(['ok', '--package-spec', '^1.0.0'])).resolves.toBeUndefined()

    expect(messages.join('\n')).toContain('Canary Lab setup skipped: setup failed')
    expect(messages.join('\n')).toContain('npx canary-lab setup')
  })
})
