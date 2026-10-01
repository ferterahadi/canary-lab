import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { digest, json } from '../files'
import { prepareNativeIsolation, privatePathsForAttempt, profile } from '../isolation'
import { repositoryAdapterDigest, repositoryScenarios, type RepositoryStudyManifest } from './adapter'
import { probeRepositoryIsolation } from './isolation'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })

function fixture(): { root: string; original: string; fixtureRoot: string } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'repository-isolation-'))); roots.push(root)
  const original = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'repository-original-'))); roots.push(original)
  const fixtureRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'repository-private-'))); roots.push(fixtureRoot)
  fs.mkdirSync(path.join(original, '.git'), { recursive: true })
  fs.writeFileSync(path.join(original, '.git/HEAD'), 'ref: refs/heads/main\n')
  fs.writeFileSync(path.join(original, 'package.json'), '{}\n')
  for (const file of ['manifest.json', 'source.tar.gz', 'oracle/e2e/encoding.spec.ts', 'held-out/overlap.patch', 'held-out/independent.patch']) {
    fs.mkdirSync(path.dirname(path.join(fixtureRoot, file)), { recursive: true })
    fs.writeFileSync(path.join(fixtureRoot, file), `private ${file}\n`)
  }
  fs.mkdirSync(path.join(root, 'runtime'), { recursive: true })
  fs.mkdirSync(path.join(root, 'frozen/fixture'), { recursive: true })
  fs.copyFileSync(path.join(fixtureRoot, 'manifest.json'), path.join(root, 'frozen/fixture/manifest.json'))
  const snapshots = {} as RepositoryStudyManifest['snapshots']
  for (const scenario of repositoryScenarios) {
    const source = path.join(root, 'attempts', scenario, 'source')
    const host = path.join(root, 'attempts', scenario, 'host')
    fs.mkdirSync(source, { recursive: true }); fs.mkdirSync(host)
    fs.writeFileSync(path.join(source, 'package.json'), '{}\n')
    fs.writeFileSync(path.join(host, 'package.json'), '{}\n')
    snapshots[scenario] = { sourceDigest: digest(source), hostDigest: digest(host), changedSourceFiles: [] }
  }
  const manifest: RepositoryStudyManifest = {
    schemaVersion: 1, kind: 'unfamiliar-repository-local-validation', paidDispatchAllowed: false, status: 'prepared',
    root, fixtureRoot, sourceCheckout: original, sourceCommit: 'a'.repeat(40), fixtureDigest: digest(path.join(root, 'frozen/fixture')),
    adapterDigest: repositoryAdapterDigest(), nodeVersion: process.version, yarnVersion: '1.22.22', snapshots,
  }
  json(path.join(root, 'repository-study.json'), manifest)
  return { root, original, fixtureRoot }
}

it('adds external private roots without allowing overlap with the attempt or runtime', () => {
  const { root, original, fixtureRoot } = fixture()
  const attempt = path.join(root, 'attempts/clean')
  expect(privatePathsForAttempt(root, attempt, [original, fixtureRoot, original])).toEqual([original, fixtureRoot])
  const sandbox = profile(root, attempt, 'canary', [original, fixtureRoot])
  expect(sandbox).toContain(`(deny file-read-data (subpath ${JSON.stringify(original)}))`)
  expect(sandbox).toContain(`(deny file-write* (subpath ${JSON.stringify(fixtureRoot)}))`)
  expect(sandbox).toContain(`(deny file-write* (literal ${JSON.stringify(path.join(attempt, 'isolation.sb'))}))`)
  expect(() => privatePathsForAttempt(root, attempt, [root])).toThrow('overlaps')
  expect(() => privatePathsForAttempt(root, attempt, [path.join(attempt, 'source')])).toThrow('overlaps')
  expect(() => privatePathsForAttempt(root, attempt, [path.join(root, 'runtime')])).toThrow('overlaps')
})

it('serializes both original checkout and held-out fixture denials into native settings', async () => {
  const { root, original, fixtureRoot } = fixture()
  if (process.platform !== 'darwin') return
  const attempt = path.join(root, 'attempts/clean')
  const native = await prepareNativeIsolation(root, attempt, 'canary', 'claude', 'codex', [original, fixtureRoot], path.join(root, 'repository-study.json'))
  const settings = JSON.parse(fs.readFileSync(native.claudeSettings, 'utf8'))
  expect(settings.sandbox.filesystem.denyRead).toEqual(expect.arrayContaining([original, fixtureRoot]))
  expect(settings.sandbox.filesystem.denyWrite).toEqual(expect.arrayContaining([original, fixtureRoot, native.claudeSettings]))
  expect(settings.permissions.deny).toContain(`Read(/${fixtureRoot}/**)`)
  expect(native.codexArgs.join(' ')).toContain(JSON.stringify(original))
  expect(native.codexArgs.join(' ')).toContain(JSON.stringify(fixtureRoot))
})

it.skipIf(process.env.CANARY_REPOSITORY_ISOLATION_TEST !== '1')('proves OS sandbox denial, including a private symlink alias, and allowed local controls', async () => {
  const { root } = fixture()
  if (process.platform !== 'darwin' || !fs.existsSync('/usr/bin/sandbox-exec')) return
  const manifest = await probeRepositoryIsolation(root)
  for (const scenario of repositoryScenarios) {
    expect(manifest.isolation?.[scenario]).toMatchObject({ osSandbox: 'passed', nativeCodex: 'unverified', nativeClaude: 'unverified' })
    expect(manifest.isolation?.[scenario].probes).toContain('symlink alias')
  }
}, 90_000)
