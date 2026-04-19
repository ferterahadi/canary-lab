import { describe, it, expect, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { EventEmitter } from 'events'

const spawn = vi.fn()
const createInterface = vi.fn()
vi.mock('child_process', () => ({ spawn }))
vi.mock('readline', () => ({
  createInterface,
  default: { createInterface },
}))

const {
  resolveVars,
  getEnvSetsDir,
  loadConfig,
  listEnvSets,
  getSlotFilesInSet,
  backup,
  applySet,
  restore,
  main,
} = await import('./switch')

const tmpDirs: string[] = []
function mkTmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-sw-'))
  tmpDirs.push(dir)
  return fs.realpathSync(dir)
}

const initialSigintListeners = process.listeners('SIGINT').slice()
afterEach(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop()!
    fs.rmSync(d, { recursive: true, force: true })
  }
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  spawn.mockReset()
  createInterface.mockReset()
  // Remove any SIGINT listeners leaked by main() under test.
  for (const listener of process.listeners('SIGINT')) {
    if (!initialSigintListeners.includes(listener)) {
      process.removeListener('SIGINT', listener as any)
    }
  }
})

describe('resolveVars', () => {
  it('replaces $VARS found in appRoots', () => {
    expect(resolveVars('$ROOT/features/x', { ROOT: '/abs' })).toBe('/abs/features/x')
  })

  it('leaves unknown $VARS intact', () => {
    expect(resolveVars('$UNKNOWN/x', {})).toBe('$UNKNOWN/x')
  })

  it('supports multiple occurrences', () => {
    expect(resolveVars('$A/$B/$A', { A: 'x', B: 'y' })).toBe('x/y/x')
  })

  it('ignores $lowercase (regex is uppercase/underscore only)', () => {
    expect(resolveVars('$lower', { lower: 'x' })).toBe('$lower')
  })
})

describe('getEnvSetsDir', () => {
  it('joins featureName to features/<name>/envsets when relative', () => {
    const root = mkTmp()
    vi.stubEnv('CANARY_LAB_PROJECT_ROOT', root)
    expect(getEnvSetsDir('my_feat')).toBe(path.join(root, 'features', 'my_feat', 'envsets'))
  })

  it('treats absolute paths as the feature dir', () => {
    expect(getEnvSetsDir('/abs/feature')).toBe('/abs/feature/envsets')
  })
})

function writeConfig(root: string, featureName: string, config: object): string {
  const envSetsDir = path.join(root, 'features', featureName, 'envsets')
  fs.mkdirSync(envSetsDir, { recursive: true })
  fs.writeFileSync(path.join(envSetsDir, 'envsets.config.json'), JSON.stringify(config))
  return envSetsDir
}

describe('loadConfig', () => {
  it('parses config and injects CANARY_LAB_PROJECT_ROOT into appRoots', () => {
    const root = mkTmp()
    fs.mkdirSync(path.join(root, 'features'))
    vi.stubEnv('CANARY_LAB_PROJECT_ROOT', root)
    writeConfig(root, 'f', {
      appRoots: { FOO: '/foo' },
      slots: {},
      feature: { slots: [], testCommand: 'x', testCwd: '$CANARY_LAB_PROJECT_ROOT' },
    })
    const cfg = loadConfig('f')
    expect(cfg.appRoots.CANARY_LAB_PROJECT_ROOT).toBe(root)
    expect(cfg.appRoots.FOO).toBe('/foo')
  })

  it('throws when config file missing', () => {
    const root = mkTmp()
    vi.stubEnv('CANARY_LAB_PROJECT_ROOT', root)
    expect(() => loadConfig('missing')).toThrow(/Missing envsets config/)
  })

  it('throws on malformed JSON', () => {
    const root = mkTmp()
    vi.stubEnv('CANARY_LAB_PROJECT_ROOT', root)
    const envSetsDir = path.join(root, 'features', 'f', 'envsets')
    fs.mkdirSync(envSetsDir, { recursive: true })
    fs.writeFileSync(path.join(envSetsDir, 'envsets.config.json'), 'not-json')
    expect(() => loadConfig('f')).toThrow()
  })
})

describe('listEnvSets', () => {
  it('returns only directories, sorted', () => {
    const dir = mkTmp()
    fs.mkdirSync(path.join(dir, 'prod'))
    fs.mkdirSync(path.join(dir, 'local'))
    fs.mkdirSync(path.join(dir, 'staging'))
    fs.writeFileSync(path.join(dir, 'README.md'), '')
    expect(listEnvSets(dir)).toEqual(['local', 'prod', 'staging'])
  })
})

describe('getSlotFilesInSet', () => {
  it('returns only the slots that exist in the set dir', () => {
    const dir = mkTmp()
    const setDir = path.join(dir, 'local')
    fs.mkdirSync(setDir)
    fs.writeFileSync(path.join(setDir, 'a.env'), '')
    expect(getSlotFilesInSet(dir, 'local', ['a.env', 'b.env'])).toEqual(['a.env'])
  })
})

describe('backup / applySet / restore round-trip', () => {
  it('backs up existing targets, applies new content, restores originals', () => {
    const root = mkTmp()
    const envSetsDir = path.join(root, 'envsets')
    const setDir = path.join(envSetsDir, 'staging')
    fs.mkdirSync(setDir, { recursive: true })
    fs.writeFileSync(path.join(setDir, 'api.env'), 'NEW=staging')

    const targetPath = path.join(root, 'api.env')
    fs.writeFileSync(targetPath, 'OLD=original')

    const targets = [{ slot: 'api.env', targetPath }]
    const records = backup(targets, 1234)

    expect(records).toHaveLength(1)
    expect(records[0].backupPath).toBe(`${targetPath}.bak.1234`)
    expect(fs.readFileSync(records[0].backupPath, 'utf-8')).toBe('OLD=original')

    applySet(envSetsDir, 'staging', targets)
    expect(fs.readFileSync(targetPath, 'utf-8')).toBe('NEW=staging')

    restore(records)
    expect(fs.readFileSync(targetPath, 'utf-8')).toBe('OLD=original')
    expect(fs.existsSync(records[0].backupPath)).toBe(false)
  })

  it('backup skips non-existent targets', () => {
    const root = mkTmp()
    const targets = [{ slot: 'x.env', targetPath: path.join(root, 'x.env') }]
    expect(backup(targets, 1)).toEqual([])
  })

  it('applySet creates parent directories as needed', () => {
    const root = mkTmp()
    const setDir = path.join(root, 'envsets', 'local')
    fs.mkdirSync(setDir, { recursive: true })
    fs.writeFileSync(path.join(setDir, 'a.env'), 'hi')
    const targetPath = path.join(root, 'deep', 'sub', 'a.env')
    applySet(path.join(root, 'envsets'), 'local', [{ slot: 'a.env', targetPath }])
    expect(fs.readFileSync(targetPath, 'utf-8')).toBe('hi')
  })
})

function seedFeature(root: string, featureName: string, sets: Record<string, Record<string, string>>) {
  const featureDir = path.join(root, 'features', featureName)
  const envSetsDir = path.join(featureDir, 'envsets')
  fs.mkdirSync(envSetsDir, { recursive: true })
  fs.writeFileSync(
    path.join(envSetsDir, 'envsets.config.json'),
    JSON.stringify({
      appRoots: {},
      slots: {
        [`${featureName}.env`]: {
          target: `$CANARY_LAB_PROJECT_ROOT/features/${featureName}/.env`,
        },
      },
      feature: {
        slots: [`${featureName}.env`],
        testCommand: 'echo hi',
        testCwd: `$CANARY_LAB_PROJECT_ROOT/features/${featureName}`,
      },
    }),
  )
  for (const [setName, files] of Object.entries(sets)) {
    const setDir = path.join(envSetsDir, setName)
    fs.mkdirSync(setDir, { recursive: true })
    for (const [file, body] of Object.entries(files)) {
      fs.writeFileSync(path.join(setDir, file), body)
    }
  }
  return { featureDir, envSetsDir }
}

function stubExit(): () => void {
  const spy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`__exit__${code}`)
  }) as never)
  return () => spy.mockRestore()
}

describe('main (switch orchestration)', () => {
  it('exits 1 when no feature-name arg', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    stubExit()
    await expect(main([])).rejects.toThrow('__exit__1')
  })

  it('--apply <set> backs up current target and copies the set file in', async () => {
    const root = mkTmp()
    vi.stubEnv('CANARY_LAB_PROJECT_ROOT', root)
    const { featureDir } = seedFeature(root, 'feat', {
      staging: { 'feat.env': 'NEW=staging' },
    })
    const target = path.join(featureDir, '.env')
    fs.writeFileSync(target, 'OLD=original')
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['feat', '--apply', 'staging'])

    expect(fs.readFileSync(target, 'utf-8')).toBe('NEW=staging')
    const siblings = fs.readdirSync(featureDir).filter((f) => f.startsWith('.env.bak.'))
    expect(siblings).toHaveLength(1)
    expect(fs.readFileSync(path.join(featureDir, siblings[0]), 'utf-8')).toBe('OLD=original')
  })

  it('--apply with unknown set exits 1', async () => {
    const root = mkTmp()
    vi.stubEnv('CANARY_LAB_PROJECT_ROOT', root)
    seedFeature(root, 'feat', { staging: { 'feat.env': 'x' } })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
    stubExit()
    await expect(main(['feat', '--apply', 'bogus'])).rejects.toThrow('__exit__1')
  })

  it('--apply without set name exits 1', async () => {
    const root = mkTmp()
    vi.stubEnv('CANARY_LAB_PROJECT_ROOT', root)
    seedFeature(root, 'feat', { staging: { 'feat.env': 'x' } })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
    stubExit()
    await expect(main(['feat', '--apply'])).rejects.toThrow('__exit__1')
  })

  it('--revert restores the latest .bak.* and removes backups', async () => {
    const root = mkTmp()
    vi.stubEnv('CANARY_LAB_PROJECT_ROOT', root)
    const { featureDir } = seedFeature(root, 'feat', { staging: { 'feat.env': 'x' } })
    const target = path.join(featureDir, '.env')
    fs.writeFileSync(target, 'CURRENT')
    fs.writeFileSync(`${target}.bak.1`, 'FIRST')
    fs.writeFileSync(`${target}.bak.2`, 'LATEST')
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['feat', '--revert'])

    expect(fs.readFileSync(target, 'utf-8')).toBe('LATEST')
    expect(fs.existsSync(`${target}.bak.1`)).toBe(false)
    expect(fs.existsSync(`${target}.bak.2`)).toBe(false)
  })

  it('interactive mode: prompts, then spawns test command with resolved cwd/cmd/args', async () => {
    const root = mkTmp()
    vi.stubEnv('CANARY_LAB_PROJECT_ROOT', root)
    const { featureDir } = seedFeature(root, 'feat', {
      local: { 'feat.env': 'LOCAL=1' },
      staging: { 'feat.env': 'STAGING=1' },
    })
    const target = path.join(featureDir, '.env')
    fs.writeFileSync(target, 'OLD')
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(process.stdout, 'write').mockImplementation((() => true) as any)

    // readline stub: answer "2" (staging)
    createInterface.mockImplementation(() => ({
      question: (_q: string, cb: (a: string) => void) => cb('2'),
      close: () => {},
    }))

    // spawn stub: returns an EventEmitter child; tests assert on args, not close lifecycle.
    const child: any = new EventEmitter()
    spawn.mockImplementation(() => child)

    await main(['feat'])

    expect(spawn).toHaveBeenCalledExactlyOnceWith(
      'echo',
      ['hi'],
      expect.objectContaining({
        cwd: path.join(root, 'features', 'feat'),
        stdio: 'inherit',
        shell: true,
      }),
    )
    // The chosen "staging" set was applied before spawn.
    expect(fs.readFileSync(target, 'utf-8')).toBe('STAGING=1')
    // Backup was written for the original
    const backups = fs.readdirSync(featureDir).filter((f) => f.startsWith('.env.bak.'))
    expect(backups).toHaveLength(1)
  })

  it('interactive mode: re-prompts on invalid answer, accepts set name', async () => {
    const root = mkTmp()
    vi.stubEnv('CANARY_LAB_PROJECT_ROOT', root)
    const { featureDir } = seedFeature(root, 'feat', {
      local: { 'feat.env': 'LOCAL=1' },
    })
    const target = path.join(featureDir, '.env')
    fs.writeFileSync(target, 'OLD')
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(process.stdout, 'write').mockImplementation((() => true) as any)

    const answers = ['bogus', 'local']
    createInterface.mockImplementation(() => ({
      question: (_q: string, cb: (a: string) => void) => cb(answers.shift()!),
      close: () => {},
    }))
    const child: any = new EventEmitter()
    spawn.mockImplementation(() => child)

    await main(['feat'])
    expect(answers).toHaveLength(0)
    expect(spawn).toHaveBeenCalledOnce()
  })

  it('interactive mode: empty envsets dir exits 1', async () => {
    const root = mkTmp()
    vi.stubEnv('CANARY_LAB_PROJECT_ROOT', root)
    seedFeature(root, 'feat', {}) // no sets
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
    stubExit()
    await expect(main(['feat'])).rejects.toThrow('__exit__1')
  })

  it('--revert with no backup files logs "No backup files found"', async () => {
    const root = mkTmp()
    vi.stubEnv('CANARY_LAB_PROJECT_ROOT', root)
    seedFeature(root, 'feat', { staging: { 'feat.env': 'x' } })
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['feat', '--revert'])

    const messages = logSpy.mock.calls.map((c) => String(c[0]))
    expect(messages.some((m) => m.includes('No backup files found'))).toBe(true)
  })

  it('interactive mode: child close(code) triggers cleanup (restore) and exit(code)', async () => {
    const root = mkTmp()
    vi.stubEnv('CANARY_LAB_PROJECT_ROOT', root)
    const { featureDir } = seedFeature(root, 'feat', {
      local: { 'feat.env': 'LOCAL=1' },
    })
    const target = path.join(featureDir, '.env')
    fs.writeFileSync(target, 'OLD')
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(process.stdout, 'write').mockImplementation((() => true) as any)

    createInterface.mockImplementation(() => ({
      question: (_q: string, cb: (a: string) => void) => cb('1'),
      close: () => {},
    }))
    const child: any = new EventEmitter()
    spawn.mockImplementation(() => child)

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`__exit__${code}`)
    }) as never)

    await main(['feat'])
    expect(fs.readFileSync(target, 'utf-8')).toBe('LOCAL=1')

    expect(() => child.emit('close', 2)).toThrow('__exit__2')
    expect(fs.readFileSync(target, 'utf-8')).toBe('OLD')

    exitSpy.mockRestore()
  })

  it('interactive mode: child error triggers cleanup and exit 1', async () => {
    const root = mkTmp()
    vi.stubEnv('CANARY_LAB_PROJECT_ROOT', root)
    const { featureDir } = seedFeature(root, 'feat', {
      local: { 'feat.env': 'LOCAL=1' },
    })
    const target = path.join(featureDir, '.env')
    fs.writeFileSync(target, 'OLD')
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(process.stdout, 'write').mockImplementation((() => true) as any)

    createInterface.mockImplementation(() => ({
      question: (_q: string, cb: (a: string) => void) => cb('1'),
      close: () => {},
    }))
    const child: any = new EventEmitter()
    spawn.mockImplementation(() => child)

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`__exit__${code}`)
    }) as never)

    await main(['feat'])
    expect(() => child.emit('error', new Error('spawn failed'))).toThrow('__exit__1')
    expect(fs.readFileSync(target, 'utf-8')).toBe('OLD')

    exitSpy.mockRestore()
  })

  it('interactive mode: SIGINT triggers cleanup and exit 130; repeat is a no-op via cleanupDone guard', async () => {
    const root = mkTmp()
    vi.stubEnv('CANARY_LAB_PROJECT_ROOT', root)
    const { featureDir } = seedFeature(root, 'feat', {
      local: { 'feat.env': 'LOCAL=1' },
    })
    const target = path.join(featureDir, '.env')
    fs.writeFileSync(target, 'OLD')
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((() => true) as any)

    createInterface.mockImplementation(() => ({
      question: (_q: string, cb: (a: string) => void) => cb('1'),
      close: () => {},
    }))
    const child: any = new EventEmitter()
    spawn.mockImplementation(() => child)

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`__exit__${code}`)
    }) as never)

    await main(['feat'])
    expect(fs.readFileSync(target, 'utf-8')).toBe('LOCAL=1')

    expect(() => process.emit('SIGINT')).toThrow('__exit__130')
    expect(fs.readFileSync(target, 'utf-8')).toBe('OLD')

    // A subsequent close firing should still exit but MUST NOT double-restore
    // (cleanupDone guard). Count how often 'Restoring original files' was written.
    const restoreCalls = () =>
      stdoutSpy.mock.calls.filter((c) =>
        String(c[0]).includes('Restoring original files'),
      ).length
    const firstCount = restoreCalls()
    expect(() => child.emit('close', 0)).toThrow('__exit__0')
    expect(restoreCalls()).toBe(firstCount)

    exitSpy.mockRestore()
  })
})
