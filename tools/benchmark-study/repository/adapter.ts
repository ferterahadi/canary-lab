import fs from 'node:fs'
import path from 'node:path'
import { changed, checked, command, copy, digest, hashes, inside, json, readJson, sha, sourceRoot } from '../files'

export const repositoryScenarios = ['clean', 'overlap', 'independent'] as const
export type RepositoryScenario = typeof repositoryScenarios[number]

interface FixtureManifest {
  schemaVersion: 1
  candidate: 'nextjs-mcp'
  sourceCommit: string
  sourceArchive: 'source.tar.gz'
  filesSha256: Record<string, string>
}

// The host app depends on the repository under test by its own package name.
// Read it from that source instead of naming one organisation's package here.
export function subjectPackageName(source: string): string {
  const { name } = readJson<{ name?: unknown }>(path.join(source, 'package.json'))
  // It is interpolated into a container setup script, so accept only npm names.
  if (typeof name !== 'string' || !/^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/.test(name)) {
    throw new Error('Repository source has no valid package name')
  }
  return name
}

export interface RepositorySnapshot {
  sourceDigest: string
  hostDigest: string
  changedSourceFiles: string[]
}

export interface RepositoryStudyManifest {
  schemaVersion: 1
  kind: 'unfamiliar-repository-local-validation'
  paidDispatchAllowed: false
  status: 'preparing' | 'prepared' | 'validated'
  root: string
  fixtureRoot: string
  sourceCheckout: string
  sourceCommit: string
  fixtureDigest: string
  adapterDigest: string
  nodeVersion: string
  yarnVersion: string
  snapshots: Partial<Record<RepositoryScenario, RepositorySnapshot>>
  isolation?: Record<RepositoryScenario, { osSandbox: 'passed'; nativeCodex: 'passed' | 'unverified'; nativeClaude: 'unverified'; probes: string[] }>
  validation?: Record<RepositoryScenario, { code: number; roster: string[]; passed: string[]; failed: string[]; skipped: string[]; evidence: string }>
  validationRuntime?: { playwrightModules: string; playwrightVersion: string; nextVersion: string; mcpSdkVersion: string; toonVersion: string; dependencyBytes: 'unverified' }
}

const requiredFixtureFiles = [
  'source.tar.gz', 'prepare.sh', 'host/package.json', 'host/yarn.lock', 'host/fixture.env',
  'package-stub/package.json', 'oracle/playwright.config.ts', 'oracle/e2e/encoding.spec.ts',
  'held-out/overlap.patch', 'held-out/independent.patch',
]

function fixtureFiles(root: string): Record<string, string> {
  const visit = (directory: string): Array<[string, string]> => fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name)
    if (entry.isSymbolicLink()) throw new Error(`Fixture symlink is unsupported: ${file}`)
    if (entry.isDirectory()) return visit(file)
    if (!entry.isFile()) throw new Error(`Fixture contains unsupported entry: ${file}`)
    return entry.name === 'manifest.json' && directory === root ? [] : [[path.relative(root, file), sha(fs.readFileSync(file))]]
  })
  return Object.fromEntries(visit(root).sort(([a], [b]) => a.localeCompare(b)))
}

export async function verifyRepositoryFixture(root: string): Promise<FixtureManifest> {
  const manifest = readJson<FixtureManifest>(path.join(root, 'manifest.json'))
  if (manifest.schemaVersion !== 1 || manifest.candidate !== 'nextjs-mcp' || manifest.sourceArchive !== 'source.tar.gz' ||
      !/^[a-f0-9]{40}$/.test(manifest.sourceCommit)) throw new Error('Unsupported repository fixture manifest')
  const actual = fixtureFiles(root)
  if (JSON.stringify(actual) !== JSON.stringify(Object.fromEntries(Object.entries(manifest.filesSha256).sort(([a], [b]) => a.localeCompare(b))))) {
    throw new Error('Repository fixture inventory or SHA-256 hash changed')
  }
  for (const file of requiredFixtureFiles) if (!Object.hasOwn(actual, file)) throw new Error(`Repository fixture missing ${file}`)
  const archive = path.join(root, manifest.sourceArchive)
  const listing = await command('tar', ['-tzf', archive], { cwd: root })
  const verbose = await command('tar', ['-tvzf', archive], { cwd: root })
  if (listing.code !== 0 || verbose.code !== 0) throw new Error('Repository source archive could not be inspected')
  const names = listing.stdout.trim().split('\n')
  if (names.length === 0 || names.some((name) => !name || name.startsWith('/') || name.split('/').some((part) => part === '..' || part === '.git') || /[\n\r\\]/.test(name))) {
    throw new Error('Repository source archive contains an unsafe path')
  }
  if (verbose.stdout.trim().split('\n').some((line) => !['-', 'd'].includes(line[0]))) {
    throw new Error('Repository source archive contains a link or special file')
  }
  return manifest
}

export function repositoryAdapterDigest(): string {
  const implementation = fs.readdirSync(__dirname).filter((name) => (name.endsWith('.ts') || name.endsWith('.cjs')) && !name.endsWith('.test.ts')).sort()
    .map((name) => `${name}:${sha(fs.readFileSync(path.join(__dirname, name)))}`)
  return sha([...implementation, ...['files.ts', 'isolation.ts', 'evaluator.ts'].map((name) => `${name}:${sha(fs.readFileSync(path.join(__dirname, '..', name)))}`)].join('\n'))
}

export function loadRepositoryStudy(root: string): RepositoryStudyManifest {
  const actual = fs.realpathSync(root)
  const manifest = readJson<RepositoryStudyManifest>(path.join(actual, 'repository-study.json'))
  if (manifest.schemaVersion !== 1 || manifest.kind !== 'unfamiliar-repository-local-validation' || manifest.paidDispatchAllowed !== false ||
      manifest.root !== actual || manifest.status === 'preparing') throw new Error('Invalid or incomplete local repository study')
  if (manifest.nodeVersion !== process.version) throw new Error('Node version changed since repository preparation')
  if (manifest.adapterDigest !== repositoryAdapterDigest() || manifest.fixtureDigest !== digest(path.join(actual, 'frozen/fixture'))) {
    throw new Error('Repository adapter or frozen fixture changed; prepare a new study')
  }
  for (const scenario of repositoryScenarios) {
    const snapshot = manifest.snapshots[scenario]
    if (!snapshot || snapshot.sourceDigest !== digest(path.join(actual, 'attempts', scenario, 'source')) ||
        snapshot.hostDigest !== digest(path.join(actual, 'attempts', scenario, 'host'))) {
      throw new Error(`Repository snapshot changed before local validation: ${scenario}`)
    }
  }
  return manifest
}

export async function prepareRepositoryStudy(options: { fixture: string; sourceCheckout: string; output: string; yarnCacheFolder?: string }): Promise<RepositoryStudyManifest> {
  const fixtureRoot = fs.realpathSync(options.fixture)
  const sourceCheckout = fs.realpathSync(options.sourceCheckout)
  const parent = fs.realpathSync(path.dirname(path.resolve(options.output)))
  const root = path.join(parent, path.basename(options.output))
  if (/[\n\r`$\\]/.test(root + fixtureRoot + sourceCheckout) ||
      [fixtureRoot, sourceCheckout, sourceRoot].some((privateRoot) => inside(privateRoot, root) || inside(root, privateRoot))) {
    throw new Error('Repository study output overlaps a protected source or contains shell interpolation characters')
  }
  if (fs.existsSync(root)) throw new Error('Repository study output already exists')
  const fixture = await verifyRepositoryFixture(fixtureRoot)
  if (await checked('git', ['rev-parse', 'HEAD'], sourceCheckout) !== fixture.sourceCommit) throw new Error('Original repository is not at the pinned fixture commit')
  const yarnVersion = await checked('yarn', ['--version'], sourceRoot)
  const manifest: RepositoryStudyManifest = {
    schemaVersion: 1, kind: 'unfamiliar-repository-local-validation', paidDispatchAllowed: false, status: 'preparing',
    root, fixtureRoot, sourceCheckout, sourceCommit: fixture.sourceCommit, fixtureDigest: '',
    adapterDigest: repositoryAdapterDigest(), nodeVersion: process.version, yarnVersion, snapshots: {},
  }
  fs.mkdirSync(path.join(root, 'frozen'), { recursive: true })
  fs.mkdirSync(path.join(root, 'runtime'), { recursive: true })
  fs.mkdirSync(path.join(root, 'attempts'), { recursive: true })
  copy(fixtureRoot, path.join(root, 'frozen/fixture'))
  manifest.fixtureDigest = digest(path.join(root, 'frozen/fixture'))
  json(path.join(root, 'repository-study.json'), manifest)
  for (const scenario of repositoryScenarios) {
    const output = path.join(root, 'attempts', scenario)
    const result = await command('/bin/bash', [path.join(root, 'frozen/fixture/prepare.sh'), output, scenario], {
      cwd: root, timeoutMs: 180_000, log: path.join(root, 'preparation', `${scenario}.log`),
      env: options.yarnCacheFolder ? { YARN_CACHE_FOLDER: fs.realpathSync(options.yarnCacheFolder) } : undefined,
    })
    if (result.code !== 0 || result.timedOut) throw new Error(`Repository ${scenario} preparation failed; inspect preparation/${scenario}.log`)
    if (fs.realpathSync(path.join(output, 'host/node_modules', subjectPackageName(path.join(output, 'source')))) !== path.join(output, 'source')) {
      throw new Error(`Repository ${scenario} host does not link to its own source`)
    }
    manifest.snapshots[scenario] = { sourceDigest: digest(path.join(output, 'source')), hostDigest: digest(path.join(output, 'host')), changedSourceFiles: [] }
    json(path.join(root, 'repository-study.json'), manifest)
  }
  const baseline = hashes(path.join(root, 'attempts/clean/source'))
  for (const scenario of repositoryScenarios) {
    manifest.snapshots[scenario]!.changedSourceFiles = changed(baseline, hashes(path.join(root, 'attempts', scenario, 'source'))).filter((name) => name.startsWith('src/'))
  }
  if (JSON.stringify(manifest.snapshots.clean!.changedSourceFiles) !== '[]' ||
      JSON.stringify(manifest.snapshots.overlap!.changedSourceFiles) !== JSON.stringify(['src/server/execute.ts']) ||
      JSON.stringify(manifest.snapshots.independent!.changedSourceFiles) !== JSON.stringify(['src/build/codegen.ts', 'src/server/util.ts'])) {
    throw new Error('Repository mutation source files differ from the frozen fixture contract')
  }
  manifest.status = 'prepared'
  json(path.join(root, 'repository-study.json'), manifest)
  return manifest
}
