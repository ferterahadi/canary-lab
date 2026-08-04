import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  FEATURE_CONFIG_NAMES,
  PLAYWRIGHT_CONFIG_NAMES,
  buildAppRoots,
  findExistingConfig,
  isValidSlotName,
  isWithin,
  listEnvFolders,
  readEnvsetsConfig,
  shortenHome,
  syncEnvsInConfig,
  writeEnvsetsConfig,
} from './feature-config-support'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-cfg-support-')))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

function makeEnvs(names: string[]): void {
  for (const n of names) fs.mkdirSync(path.join(tmpDir, 'envsets', n), { recursive: true })
}

describe('findExistingConfig', () => {
  it('returns the first candidate that exists, with its format', () => {
    fs.writeFileSync(path.join(tmpDir, 'feature.config.js'), '')
    expect(findExistingConfig(tmpDir, FEATURE_CONFIG_NAMES)).toEqual({
      path: path.join(tmpDir, 'feature.config.js'),
      format: 'js',
    })
  })

  it('prefers the earlier candidate when several exist', () => {
    fs.writeFileSync(path.join(tmpDir, 'playwright.config.ts'), '')
    fs.writeFileSync(path.join(tmpDir, 'playwright.config.js'), '')
    expect(findExistingConfig(tmpDir, PLAYWRIGHT_CONFIG_NAMES)?.format).toBe('ts')
  })

  it('returns null when none exist', () => {
    expect(findExistingConfig(tmpDir, FEATURE_CONFIG_NAMES)).toBeNull()
  })
})

describe('listEnvFolders', () => {
  it('returns [] when there is no envsets dir', () => {
    expect(listEnvFolders(tmpDir)).toEqual([])
  })

  it('lists only directories, alphabetised, ignoring files', () => {
    makeEnvs(['staging', 'local'])
    fs.writeFileSync(path.join(tmpDir, 'envsets', 'envsets.config.json'), '{}')
    expect(listEnvFolders(tmpDir)).toEqual(['local', 'staging'])
  })
})

describe('syncEnvsInConfig', () => {
  it('is a no-op when the feature has no config file', () => {
    makeEnvs(['local'])
    expect(() => syncEnvsInConfig(tmpDir)).not.toThrow()
  })

  it('rewrites the envs array to match the folders on disk', () => {
    const cfgPath = path.join(tmpDir, 'feature.config.cjs')
    fs.writeFileSync(cfgPath, "module.exports = { config: { name: 'a', envs: ['stale'] } }")
    makeEnvs(['local', 'prod'])

    syncEnvsInConfig(tmpDir)

    const out = fs.readFileSync(cfgPath, 'utf-8')
    expect(out).toMatch(/'local'/)
    expect(out).toMatch(/'prod'/)
    expect(out).not.toContain('stale')
  })

  it('leaves the file untouched when the envs array already matches', () => {
    const cfgPath = path.join(tmpDir, 'feature.config.cjs')
    fs.writeFileSync(cfgPath, "module.exports = { config: { name: 'a', envs: ['local'] } }")
    makeEnvs(['local'])
    syncEnvsInConfig(tmpDir)
    const before = fs.readFileSync(cfgPath, 'utf-8')

    const write = vi.spyOn(fs, 'writeFileSync')
    syncEnvsInConfig(tmpDir)

    expect(write).not.toHaveBeenCalled()
    expect(fs.readFileSync(cfgPath, 'utf-8')).toBe(before)
  })
})

describe('isValidSlotName', () => {
  it('accepts ordinary slot file names', () => {
    for (const name of ['feature.env', 'api-1.env', '_local', 'A.B-c_1']) {
      expect(isValidSlotName(name)).toBe(true)
    }
  })

  it('rejects anything with a path separator or an out-of-class character', () => {
    for (const name of ['../escape', 'a/b', '', 'has space', 'sla$h']) {
      expect(isValidSlotName(name)).toBe(false)
    }
  })

  // These two pass the character class — `.` is inside it — but name a
  // directory. Joined onto `envsets/<env>/` they resolve to the env folder or
  // to the envsets root, so a write would hit EISDIR and a delete would remove
  // a whole env. Rejecting them is what lets the routes skip an `isWithin`
  // re-check on the joined path.
  it('rejects "." and ".." even though the character class allows them', () => {
    expect(isValidSlotName('.')).toBe(false)
    expect(isValidSlotName('..')).toBe(false)
  })
})

describe('isWithin', () => {
  it('is true for the root itself and for descendants', () => {
    expect(isWithin('/a/b', '/a/b')).toBe(true)
    expect(isWithin('/a/b', '/a/b/c/d')).toBe(true)
  })

  it('is false for a sibling, an ancestor, or an unrelated absolute path', () => {
    expect(isWithin('/a/b', '/a/bb')).toBe(false)
    expect(isWithin('/a/b', '/a')).toBe(false)
    expect(isWithin('/a/b', '/x/y')).toBe(false)
  })
})

describe('readEnvsetsConfig / writeEnvsetsConfig', () => {
  it('returns {} when the file is absent', () => {
    expect(readEnvsetsConfig(path.join(tmpDir, 'envsets'))).toEqual({})
  })

  it('returns {} when the file is unparseable rather than throwing', () => {
    const dir = path.join(tmpDir, 'envsets')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'envsets.config.json'), '{ not json')
    expect(readEnvsetsConfig(dir)).toEqual({})
  })

  it('round-trips through write, creating the dir if needed', () => {
    const dir = path.join(tmpDir, 'envsets')
    writeEnvsetsConfig(dir, { slots: { 'feature.env': { description: 'd' } } })
    expect(readEnvsetsConfig(dir)).toEqual({ slots: { 'feature.env': { description: 'd' } } })
  })
})

describe('buildAppRoots', () => {
  it('always seeds the two project-root aliases', () => {
    const roots = buildAppRoots({})
    expect(roots.CANARY_LAB).toBe(roots.CANARY_LAB_PROJECT_ROOT)
    expect(typeof roots.CANARY_LAB_PROJECT_ROOT).toBe('string')
  })

  it('lets a config-supplied root override and extend the defaults', () => {
    const roots = buildAppRoots({ appRoots: { CANARY_LAB: '/pinned', OTHER: '/o' } })
    expect(roots.CANARY_LAB).toBe('/pinned')
    expect(roots.OTHER).toBe('/o')
  })
})

describe('shortenHome', () => {
  it('collapses the home dir to ~', () => {
    const home = os.homedir()
    expect(shortenHome(home)).toBe('~')
    expect(shortenHome(path.join(home, 'x', 'y'))).toBe(path.join('~', 'x', 'y'))
  })

  it('leaves a path outside home alone, including a near-miss prefix', () => {
    const home = os.homedir()
    expect(shortenHome('/somewhere/else')).toBe('/somewhere/else')
    expect(shortenHome(home + '-not-home')).toBe(home + '-not-home')
  })
})
