import { describe, it, expect, afterEach, vi } from 'vitest'

import fs from 'fs'

import os from 'os'

import path from 'path'

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

function writeConfig(root: string, featureName: string, config: object): string {
  const envSetsDir = path.join(root, 'features', featureName, 'envsets')
  fs.mkdirSync(envSetsDir, { recursive: true })
  fs.writeFileSync(path.join(envSetsDir, 'envsets.config.json'), JSON.stringify(config))
  return envSetsDir
}

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

  it('applySet transforms content through the optional resolver', () => {
    const root = mkTmp()
    const setDir = path.join(root, 'envsets', 'local')
    fs.mkdirSync(setDir, { recursive: true })
    fs.writeFileSync(path.join(setDir, 'app.env'), 'PORT=${port.api}\nSTATIC=keep')
    const targetPath = path.join(root, 'app.env')
    applySet(path.join(root, 'envsets'), 'local', [{ slot: 'app.env', targetPath }], (c) => c.replace('${port.api}', '51234'))
    expect(fs.readFileSync(targetPath, 'utf-8')).toBe('PORT=51234\nSTATIC=keep')
  })

  it('applySet copies verbatim when no resolver is passed', () => {
    const root = mkTmp()
    const setDir = path.join(root, 'envsets', 'local')
    fs.mkdirSync(setDir, { recursive: true })
    fs.writeFileSync(path.join(setDir, 'app.env'), 'PORT=${port.api}')
    const targetPath = path.join(root, 'app.env')
    applySet(path.join(root, 'envsets'), 'local', [{ slot: 'app.env', targetPath }])
    expect(fs.readFileSync(targetPath, 'utf-8')).toBe('PORT=${port.api}')
  })

  it('applySet skips a slot whose source file is absent from the set', () => {
    const root = mkTmp()
    const setDir = path.join(root, 'envsets', 'local')
    fs.mkdirSync(setDir, { recursive: true })
    // No 'missing.env' written into setDir.
    const targetPath = path.join(root, 'missing.env')
    applySet(path.join(root, 'envsets'), 'local', [{ slot: 'missing.env', targetPath }])
    expect(fs.existsSync(targetPath)).toBe(false)
  })

  it('restore skips a record whose backup file no longer exists', () => {
    const root = mkTmp()
    const originalPath = path.join(root, 'a.env')
    fs.writeFileSync(originalPath, 'CURRENT')
    const backupPath = path.join(root, 'a.env.bak.999') // never created
    restore([{ originalPath, backupPath }])
    expect(fs.readFileSync(originalPath, 'utf-8')).toBe('CURRENT')
    expect(fs.existsSync(backupPath)).toBe(false)
  })
})
