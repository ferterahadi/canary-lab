import { describe, it, expect, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { hydrateEnvsetIntoWorktrees } from './worktree-hydrate'

const tmpDirs: string[] = []
function mkTmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-wh-'))
  tmpDirs.push(dir)
  return fs.realpathSync(dir)
}

afterEach(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true })
})

/** A featureDir with an envsets config whose slots point into `repoRoot`. */
function scaffold(opts: {
  repoRoot: string
  slots: Record<string, { target: string; content: string }>
  setName?: string
}): string {
  const featureDir = mkTmp()
  const setName = opts.setName ?? 'local'
  const setDir = path.join(featureDir, 'envsets', setName)
  fs.mkdirSync(setDir, { recursive: true })
  const config = {
    appRoots: {},
    slots: Object.fromEntries(
      Object.entries(opts.slots).map(([slot, s]) => [slot, { description: slot, target: s.target }]),
    ),
    feature: { slots: Object.keys(opts.slots), testCommand: 'true', testCwd: featureDir },
  }
  fs.writeFileSync(path.join(featureDir, 'envsets', 'envsets.config.json'), JSON.stringify(config))
  for (const [slot, s] of Object.entries(opts.slots)) {
    fs.writeFileSync(path.join(setDir, slot), s.content)
  }
  return featureDir
}

describe('hydrateEnvsetIntoWorktrees', () => {
  it('writes a slot whose target lies under a mapped root into the worktree at the same relative path', () => {
    const repoRoot = mkTmp()
    const worktreeRoot = mkTmp()
    const target = path.join(repoRoot, 'svc/src/main/resources/application-local.properties')
    const featureDir = scaffold({
      repoRoot,
      slots: { 'application-local.properties': { target, content: 'db=jdbc:mysql://localhost:3306/x\n' } },
    })

    const res = hydrateEnvsetIntoWorktrees({
      featureDir,
      setName: 'local',
      roots: [{ sourceRoot: repoRoot, worktreeRoot }],
    })

    const dest = path.join(worktreeRoot, 'svc/src/main/resources/application-local.properties')
    expect(res.written).toEqual([dest])
    expect(fs.readFileSync(dest, 'utf-8')).toBe('db=jdbc:mysql://localhost:3306/x\n')
  })

  it('skips targets outside every mapped root (the real-path apply covers those)', () => {
    const repoRoot = mkTmp()
    const elsewhere = mkTmp()
    const worktreeRoot = mkTmp()
    const featureDir = scaffold({
      repoRoot,
      slots: { 'feature.env': { target: path.join(elsewhere, '.env'), content: 'A=1\n' } },
    })

    const res = hydrateEnvsetIntoWorktrees({
      featureDir,
      setName: 'local',
      roots: [{ sourceRoot: repoRoot, worktreeRoot }],
    })

    expect(res.written).toEqual([])
    expect(fs.existsSync(path.join(worktreeRoot, '.env'))).toBe(false)
  })

  it('no-ops without an envsets.config.json', () => {
    const featureDir = mkTmp()
    const res = hydrateEnvsetIntoWorktrees({
      featureDir,
      setName: 'local',
      roots: [{ sourceRoot: mkTmp(), worktreeRoot: mkTmp() }],
    })
    expect(res.written).toEqual([])
    res.restore() // must not throw
  })

  it('skips slots absent from the chosen set', () => {
    const repoRoot = mkTmp()
    const worktreeRoot = mkTmp()
    const featureDir = scaffold({
      repoRoot,
      slots: { 'application.properties': { target: path.join(repoRoot, 'application.properties'), content: 'x=1\n' } },
    })
    fs.rmSync(path.join(featureDir, 'envsets', 'local', 'application.properties'))

    const res = hydrateEnvsetIntoWorktrees({
      featureDir,
      setName: 'local',
      roots: [{ sourceRoot: repoRoot, worktreeRoot }],
    })
    expect(res.written).toEqual([])
  })

  it('restore() reverts overwritten bytes and unlinks created files', () => {
    const repoRoot = mkTmp()
    const worktreeRoot = mkTmp()
    // Slot 1 overwrites a checked-in file; slot 2 creates a fresh one.
    const existingRel = 'svc/application-local.properties'
    fs.mkdirSync(path.join(worktreeRoot, 'svc'), { recursive: true })
    fs.writeFileSync(path.join(worktreeRoot, existingRel), 'checked-in: db-host\n')
    const featureDir = scaffold({
      repoRoot,
      slots: {
        'application-local.properties': { target: path.join(repoRoot, existingRel), content: 'captured: localhost\n' },
        'extra.env': { target: path.join(repoRoot, 'svc/.env'), content: 'B=2\n' },
      },
    })

    const res = hydrateEnvsetIntoWorktrees({
      featureDir,
      setName: 'local',
      roots: [{ sourceRoot: repoRoot, worktreeRoot }],
    })
    expect(fs.readFileSync(path.join(worktreeRoot, existingRel), 'utf-8')).toBe('captured: localhost\n')
    expect(fs.readFileSync(path.join(worktreeRoot, 'svc/.env'), 'utf-8')).toBe('B=2\n')

    res.restore()
    expect(fs.readFileSync(path.join(worktreeRoot, existingRel), 'utf-8')).toBe('checked-in: db-host\n')
    expect(fs.existsSync(path.join(worktreeRoot, 'svc/.env'))).toBe(false)
  })

  it('applies the resolve transform when given, and reports no port tokens', () => {
    const repoRoot = mkTmp()
    const worktreeRoot = mkTmp()
    const featureDir = scaffold({
      repoRoot,
      slots: { 'app.properties': { target: path.join(repoRoot, 'app.properties'), content: 'url=http://localhost:${port.api}/\n' } },
    })

    const res = hydrateEnvsetIntoWorktrees({
      featureDir,
      setName: 'local',
      roots: [{ sourceRoot: repoRoot, worktreeRoot }],
      resolve: (c) => c.replace('${port.api}', '61234'),
    })
    expect(fs.readFileSync(path.join(worktreeRoot, 'app.properties'), 'utf-8')).toBe('url=http://localhost:61234/\n')
    expect(res.portTokenSlots).toEqual([])
  })

  it('without resolve, leaves ${port.*} tokens verbatim and reports the slot', () => {
    const repoRoot = mkTmp()
    const worktreeRoot = mkTmp()
    const featureDir = scaffold({
      repoRoot,
      slots: { 'app.properties': { target: path.join(repoRoot, 'app.properties'), content: 'url=http://localhost:${port.api}/\n' } },
    })

    const res = hydrateEnvsetIntoWorktrees({
      featureDir,
      setName: 'local',
      roots: [{ sourceRoot: repoRoot, worktreeRoot }],
    })
    expect(fs.readFileSync(path.join(worktreeRoot, 'app.properties'), 'utf-8')).toBe('url=http://localhost:${port.api}/\n')
    expect(res.portTokenSlots).toEqual(['app.properties'])
  })

  it('contains symlinked targets: a target reached through a symlinked ancestor still maps into the worktree', () => {
    const realRoot = mkTmp()
    const linkParent = mkTmp()
    const linkedRoot = path.join(linkParent, 'repo-link')
    fs.symlinkSync(realRoot, linkedRoot)
    const worktreeRoot = mkTmp()
    // Config records the SYMLINKED path; the mapped root is the REAL one
    // (git resolves symlinks in --show-toplevel).
    const featureDir = scaffold({
      repoRoot: realRoot,
      slots: { 'app.env': { target: path.join(linkedRoot, 'cfg/app.env'), content: 'C=3\n' } },
    })

    const res = hydrateEnvsetIntoWorktrees({
      featureDir,
      setName: 'local',
      roots: [{ sourceRoot: realRoot, worktreeRoot }],
    })
    expect(res.written).toEqual([path.join(worktreeRoot, 'cfg/app.env')])
  })
})
