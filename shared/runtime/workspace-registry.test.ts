import { afterEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  canaryLabHome,
  readWorkspaceRegistry,
  registryPath,
  upsertWorkspace,
} from './workspace-registry'

const tmpDirs: string[] = []

function mkTmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-registry-'))
  tmpDirs.push(dir)
  return fs.realpathSync(dir)
}

afterEach(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true })
})

describe('canaryLabHome', () => {
  it('prefers an explicit CANARY_LAB_HOME over the real home dir', () => {
    // Isolated processes (smoke tests, CI) set this so they never write into
    // the developer's real ~/.canary-lab.
    expect(canaryLabHome({ CANARY_LAB_HOME: '/tmp/isolated' })).toBe('/tmp/isolated')
    expect(canaryLabHome({ CANARY_LAB_HOME: '  /tmp/padded  ' })).toBe('/tmp/padded')
    expect(registryPath('/tmp/isolated')).toBe('/tmp/isolated/.canary-lab/workspaces.json')
  })

  it('falls back to the home dir when the override is unset or blank', () => {
    expect(canaryLabHome({})).toBe(os.homedir())
    expect(canaryLabHome({ CANARY_LAB_HOME: '   ' })).toBe(os.homedir())
  })
})

describe('workspace registry', () => {
  it('returns an empty registry when the file is missing or malformed', () => {
    const home = mkTmp()
    expect(readWorkspaceRegistry(home)).toEqual({ version: 1, workspaces: [] })

    fs.mkdirSync(path.dirname(registryPath(home)), { recursive: true })
    fs.writeFileSync(registryPath(home), '{not-json')

    expect(readWorkspaceRegistry(home)).toEqual({ version: 1, workspaces: [] })
  })

  it('upserts workspaces by real path', () => {
    const home = mkTmp()
    const workspace = path.join(mkTmp(), 'my-folder')
    fs.mkdirSync(workspace)

    const first = upsertWorkspace(workspace, {
      homeDir: home,
      now: new Date('2026-05-24T00:00:00.000Z'),
    })
    const second = upsertWorkspace(workspace, {
      homeDir: home,
      now: new Date('2026-05-24T00:01:00.000Z'),
    })

    expect(first.name).toBe('my-folder')
    expect(second.createdAt).toBe('2026-05-24T00:00:00.000Z')
    expect(second.updatedAt).toBe('2026-05-24T00:01:00.000Z')
    expect(readWorkspaceRegistry(home).workspaces).toHaveLength(1)
  })

  it('discards a registry written by a different schema version', () => {
    const home = mkTmp()
    fs.mkdirSync(path.dirname(registryPath(home)), { recursive: true })
    fs.writeFileSync(registryPath(home), JSON.stringify({ version: 2, workspaces: [] }))
    expect(readWorkspaceRegistry(home)).toEqual({ version: 1, workspaces: [] })

    fs.writeFileSync(registryPath(home), JSON.stringify({ version: 1, workspaces: 'nope' }))
    expect(readWorkspaceRegistry(home)).toEqual({ version: 1, workspaces: [] })
  })

  it('drops entries that are not well-formed workspace records', () => {
    // A hand-edited or partially-written registry must not surface half
    // entries: the bridge resolves a workspace by `path`, so an entry without
    // one would resolve to undefined and boot the server rooted nowhere.
    const home = mkTmp()
    fs.mkdirSync(path.dirname(registryPath(home)), { recursive: true })
    fs.writeFileSync(registryPath(home), JSON.stringify({
      version: 1,
      workspaces: [
        null,
        'a string',
        { name: 'no-path', createdAt: 'x', updatedAt: 'x' },
        { name: 'ok', path: '/tmp/ok', createdAt: 'x', updatedAt: 'x' },
      ],
    }))
    expect(readWorkspaceRegistry(home).workspaces).toEqual([
      { name: 'ok', path: '/tmp/ok', createdAt: 'x', updatedAt: 'x' },
    ])
  })

  it('sorts multiple workspaces by name and garbage-collects vanished ones', () => {
    const home = mkTmp()
    const parent = mkTmp()
    const zulu = path.join(parent, 'zulu')
    const alpha = path.join(parent, 'alpha')
    const gone = path.join(parent, 'gone')
    for (const dir of [zulu, alpha, gone]) fs.mkdirSync(dir)

    upsertWorkspace(gone, { homeDir: home })
    upsertWorkspace(zulu, { homeDir: home })
    upsertWorkspace(alpha, { homeDir: home })
    expect(readWorkspaceRegistry(home).workspaces.map((w) => w.name)).toEqual(['alpha', 'gone', 'zulu'])

    // Deleting a workspace directory must evict it on the next upsert —
    // otherwise the recency heuristic keeps resolving to a dead path.
    fs.rmSync(gone, { recursive: true, force: true })
    upsertWorkspace(zulu, { homeDir: home })
    expect(readWorkspaceRegistry(home).workspaces.map((w) => w.name)).toEqual(['alpha', 'zulu'])
  })

  it('breaks a name tie by path so the order is stable', () => {
    // Two checkouts of the same repo share a basename; without the path
    // tiebreak their relative order would depend on sort stability rather
    // than on the data.
    const home = mkTmp()
    const parent = mkTmp()
    const second = path.join(parent, 'b', 'api')
    const first = path.join(parent, 'a', 'api')
    fs.mkdirSync(second, { recursive: true })
    fs.mkdirSync(first, { recursive: true })

    upsertWorkspace(second, { homeDir: home })
    upsertWorkspace(first, { homeDir: home })
    expect(readWorkspaceRegistry(home).workspaces.map((w) => w.path)).toEqual([first, second])
  })

  it('matches paths case-insensitively on Windows', () => {
    // Both paths are non-existent, so realpath leaves their casing intact and
    // the comparison itself decides the outcome. Preserving `createdAt` is the
    // observable proof the existing entry was matched rather than replaced —
    // on a case-sensitive platform the seeded entry would be GC'd instead.
    const home = mkTmp()
    fs.mkdirSync(path.dirname(registryPath(home)), { recursive: true })
    fs.writeFileSync(registryPath(home), JSON.stringify({
      version: 1,
      workspaces: [{
        name: 'Bar',
        path: path.resolve('/tmp/Foo/Bar'),
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      }],
    }))

    const realPlatform = process.platform
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    try {
      const entry = upsertWorkspace(path.resolve('/tmp/foo/bar'), {
        homeDir: home,
        now: new Date('2026-06-01T00:00:00.000Z'),
      })
      expect(entry.createdAt).toBe('2026-01-01T00:00:00.000Z')
      expect(entry.updatedAt).toBe('2026-06-01T00:00:00.000Z')
      expect(readWorkspaceRegistry(home).workspaces).toHaveLength(1)
    } finally {
      Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true })
    }
  })

  it('keeps a workspace whose directory does not exist yet', () => {
    // realpath fails on a missing path, so the resolved-path fallback is what
    // lets `canary-lab init` register a workspace it is about to create.
    const home = mkTmp()
    const missing = path.join(mkTmp(), 'not-created-yet')
    const entry = upsertWorkspace(missing, { homeDir: home })
    expect(entry.path).toBe(path.resolve(missing))
    expect(readWorkspaceRegistry(home).workspaces).toHaveLength(1)
  })
})
