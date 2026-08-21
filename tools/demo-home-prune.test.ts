import { afterEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
// @ts-expect-error — plain .mjs helper, no type declarations by design.
import { pruneDemoStateFromRealHome } from './demo-home-prune.mjs'

const tmpDirs: string[] = []
function mkDirs(): { registryDir: string; tempRoot: string } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-prune-')))
  tmpDirs.push(root)
  const registryDir = path.join(root, 'home', '.canary-lab')
  fs.mkdirSync(registryDir, { recursive: true })
  return { registryDir, tempRoot: path.join(root, 'canary-lab-demo-x') }
}
afterEach(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true })
})

function write(registryDir: string, file: string, body: unknown): void {
  fs.writeFileSync(path.join(registryDir, file), JSON.stringify(body))
}
function read(registryDir: string, file: string): any {
  return JSON.parse(fs.readFileSync(path.join(registryDir, file), 'utf-8'))
}

describe('pruneDemoStateFromRealHome', () => {
  // The entry this exists for: `canary-lab setup` run by hand in the demo folder
  // registers a temp workspace in the real registry, where it becomes the newest
  // thing a client resolves to — long after the demo is gone.
  it('drops a demo workspace while keeping the durable one', () => {
    const { registryDir, tempRoot } = mkDirs()
    write(registryDir, 'workspaces.json', {
      version: 1,
      workspaces: [
        { name: 'canary-lab-workspace', path: '/Users/x/Documents/canary-lab-workspace' },
        { name: 'demo-project', path: path.join(tempRoot, 'demo-project') },
      ],
    })

    expect(pruneDemoStateFromRealHome(registryDir, tempRoot)).toEqual(['workspaces.json'])
    expect(read(registryDir, 'workspaces.json').workspaces.map((w: any) => w.name)).toEqual(['canary-lab-workspace'])
  })

  // The SIGKILL path: a demo server that never got to unregister itself.
  it('drops a demo server record by projectRoot', () => {
    const { registryDir, tempRoot } = mkDirs()
    write(registryDir, 'active-servers.json', {
      version: 1,
      servers: [
        { projectRoot: '/Users/x/Documents/canary-lab-workspace', port: 7421, pid: 1, updatedAt: 'z' },
        { projectRoot: path.join(tempRoot, 'demo-project'), port: 50258, pid: 2, updatedAt: 'z' },
      ],
    })

    expect(pruneDemoStateFromRealHome(registryDir, tempRoot)).toEqual(['active-servers.json'])
    expect(read(registryDir, 'active-servers.json').servers.map((s: any) => s.port)).toEqual([7421])
  })

  it('reports both files when both name the demo', () => {
    const { registryDir, tempRoot } = mkDirs()
    write(registryDir, 'active-servers.json', {
      version: 1,
      servers: [{ projectRoot: path.join(tempRoot, 'demo-project'), port: 1, pid: 1, updatedAt: 'z' }],
    })
    write(registryDir, 'workspaces.json', {
      version: 1,
      workspaces: [{ name: 'demo-project', path: path.join(tempRoot, 'demo-project') }],
    })

    expect(pruneDemoStateFromRealHome(registryDir, tempRoot)).toEqual(['active-servers.json', 'workspaces.json'])
  })

  it('rewrites nothing when no entry belongs to the demo', () => {
    const { registryDir, tempRoot } = mkDirs()
    write(registryDir, 'workspaces.json', { version: 1, workspaces: [{ name: 'a', path: '/work/a' }] })
    const before = fs.readFileSync(path.join(registryDir, 'workspaces.json'), 'utf-8')

    expect(pruneDemoStateFromRealHome(registryDir, tempRoot)).toEqual([])
    expect(fs.readFileSync(path.join(registryDir, 'workspaces.json'), 'utf-8')).toBe(before)
  })

  // A sibling directory that merely shares the temp root's name prefix is NOT
  // the demo's — deleting it would remove a workspace the user still has.
  it('leaves a path that only shares a name prefix alone', () => {
    const { registryDir, tempRoot } = mkDirs()
    write(registryDir, 'workspaces.json', { version: 1, workspaces: [{ name: 'sibling', path: `${tempRoot}-other` }] })

    expect(pruneDemoStateFromRealHome(registryDir, tempRoot)).toEqual([])
  })

  it('ignores a registry file that does not exist', () => {
    const { registryDir, tempRoot } = mkDirs()
    expect(pruneDemoStateFromRealHome(registryDir, tempRoot)).toEqual([])
  })

  it('ignores an entry list that is not an array', () => {
    const { registryDir, tempRoot } = mkDirs()
    write(registryDir, 'workspaces.json', { version: 1, workspaces: 'nope' })
    expect(pruneDemoStateFromRealHome(registryDir, tempRoot)).toEqual([])
  })

  it('skips an entry with no location field', () => {
    const { registryDir, tempRoot } = mkDirs()
    write(registryDir, 'workspaces.json', { version: 1, workspaces: [{ name: 'headless' }] })
    expect(pruneDemoStateFromRealHome(registryDir, tempRoot)).toEqual([])
  })

  // Best-effort: a demo exit must never fail because a registry is unreadable.
  it('warns instead of throwing on malformed JSON', () => {
    const { registryDir, tempRoot } = mkDirs()
    fs.writeFileSync(path.join(registryDir, 'workspaces.json'), '{ not json')
    const warnings: string[] = []

    expect(pruneDemoStateFromRealHome(registryDir, tempRoot, (m: string) => warnings.push(m))).toEqual([])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('could not prune')
  })

  it('swallows a warning with no handler supplied', () => {
    const { registryDir, tempRoot } = mkDirs()
    fs.writeFileSync(path.join(registryDir, 'workspaces.json'), '{ not json')
    expect(() => pruneDemoStateFromRealHome(registryDir, tempRoot)).not.toThrow()
  })
})
