import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { addWorktree, removeWorktree } from './repo-worktree'
import { prepareWorktreeDependencies } from './dependency-provenance'

let root: string
let source: string

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim()
}

function initRepo(dir: string, schema = 'model User { id Int @id }'): void {
  fs.mkdirSync(dir, { recursive: true })
  git(dir, 'init', '-q')
  git(dir, 'config', 'user.email', 'test@example.com')
  git(dir, 'config', 'user.name', 'Test')
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ packageManager: 'npm@10.0.0' }))
  fs.writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: {} }))
  fs.mkdirSync(path.join(dir, 'prisma'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'prisma', 'schema.prisma'), schema)
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'init')
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-dependency-provenance-'))
  source = path.join(root, 'source')
  initRepo(source)
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('prepareWorktreeDependencies', () => {
  it('keeps a legacy shared dependency tree runnable but explicitly unknown', async () => {
    fs.mkdirSync(path.join(source, 'node_modules', 'pkg'), { recursive: true })
    const handle = await addWorktree({ repoName: 'app', localPath: source, worktreesDir: path.join(root, 'run', 'worktrees') })

    const result = await prepareWorktreeDependencies({ handle, runDir: path.join(root, 'run') })

    expect(result).toMatchObject({ verdict: 'unknown', mode: 'shared' })
    expect(result.warning).toMatch(/no target-owned compatibility proof/i)
    expect(fs.lstatSync(path.join(handle.worktreeRoot, 'node_modules')).isSymbolicLink()).toBe(true)
    await removeWorktree(handle)
  })

  it('blocks a shared generated client owned by a checkout with different generator inputs', async () => {
    const dependencyOwner = path.join(root, 'dependency-owner')
    initRepo(dependencyOwner, 'model Merchant { id Int @id }')
    fs.mkdirSync(path.join(dependencyOwner, 'node_modules'), { recursive: true })
    fs.symlinkSync(path.join(dependencyOwner, 'node_modules'), path.join(source, 'node_modules'), 'dir')
    const handle = await addWorktree({ repoName: 'app', localPath: source, worktreesDir: path.join(root, 'run', 'worktrees') })

    const result = await prepareWorktreeDependencies({
      handle,
      runDir: path.join(root, 'run'),
      config: { generatorInputs: ['prisma/schema.prisma'] },
    })

    expect(result).toMatchObject({ verdict: 'incompatible', incompatibilityCause: 'generator-input-mismatch' })
    expect(result.dependencyRealPath).toBe(fs.realpathSync(path.join(dependencyOwner, 'node_modules')))
    expect(result.generatorInputs[0]?.sha256).not.toBe(result.dependencyGeneratorInputs[0]?.sha256)
    await removeWorktree(handle)
  })

  it('resolves a nested repo path against the dependency-owning checkout', async () => {
    const dependencyOwner = path.join(root, 'dependency-owner')
    initRepo(dependencyOwner)
    for (const [checkout, model] of [[source, 'User'], [dependencyOwner, 'Merchant']] as const) {
      const nested = path.join(checkout, 'apps', 'api', 'prisma')
      fs.mkdirSync(nested, { recursive: true })
      fs.writeFileSync(path.join(nested, 'schema.prisma'), `model ${model} { id Int @id }`)
      git(checkout, 'add', '-A')
      git(checkout, 'commit', '-q', '-m', 'nested api')
    }
    fs.mkdirSync(path.join(dependencyOwner, 'node_modules'), { recursive: true })
    fs.symlinkSync(path.join(dependencyOwner, 'node_modules'), path.join(source, 'node_modules'), 'dir')
    const handle = await addWorktree({
      repoName: 'api',
      localPath: path.join(source, 'apps', 'api'),
      worktreesDir: path.join(root, 'run', 'worktrees'),
    })

    const result = await prepareWorktreeDependencies({
      handle,
      runDir: path.join(root, 'run'),
      config: { generatorInputs: ['prisma/schema.prisma'] },
    })

    expect(result).toMatchObject({ verdict: 'incompatible', incompatibilityCause: 'generator-input-mismatch' })
    expect(result.dependencyGeneratorInputs[0]?.sha256).not.toBe(result.generatorInputs[0]?.sha256)
    await removeWorktree(handle)
  })

  it('runs explicit isolated preparation and validation without linking the source dependencies', async () => {
    fs.mkdirSync(path.join(source, 'node_modules', 'shared-only'), { recursive: true })
    const handle = await addWorktree({ repoName: 'app', localPath: source, worktreesDir: path.join(root, 'run', 'worktrees') })

    const result = await prepareWorktreeDependencies({
      handle,
      runDir: path.join(root, 'run'),
      config: {
        mode: 'isolated',
        prepareCommand: 'mkdir -p node_modules/local-only',
        validateCommand: 'test -d node_modules/local-only && env TOKEN=do-not-persist printf "TOKEN=do-not-persist\\n"',
      },
    })

    expect(result).toMatchObject({ verdict: 'compatible', mode: 'isolated' })
    expect(result.validation?.command).toContain('TOKEN=[REDACTED]')
    expect(result.validation?.command).not.toContain('do-not-persist')
    expect(fs.lstatSync(path.join(handle.worktreeRoot, 'node_modules')).isSymbolicLink()).toBe(false)
    expect(fs.existsSync(path.join(handle.worktreeRoot, 'node_modules', 'shared-only'))).toBe(false)
    expect(fs.readFileSync(result.validation!.logPath, 'utf-8')).toContain('TOKEN=[REDACTED]')
    expect(fs.readFileSync(result.validation!.logPath, 'utf-8')).not.toContain('do-not-persist')
    await removeWorktree(handle)
  })

  it('refuses a prepare command in shared mode before it can mutate linked dependencies', async () => {
    fs.mkdirSync(path.join(source, 'node_modules'), { recursive: true })
    const handle = await addWorktree({ repoName: 'app', localPath: source, worktreesDir: path.join(root, 'run', 'worktrees') })

    const result = await prepareWorktreeDependencies({
      handle,
      runDir: path.join(root, 'run'),
      config: { prepareCommand: 'touch node_modules/should-not-exist' },
    })

    expect(result).toMatchObject({ verdict: 'incompatible', incompatibilityCause: 'shared-prepare-command' })
    expect(fs.existsSync(path.join(source, 'node_modules', 'should-not-exist'))).toBe(false)
    await removeWorktree(handle)
  })

  it('distinguishes a lockfile mismatch from generator-input evidence', async () => {
    fs.mkdirSync(path.join(source, 'node_modules'))
    const handle = await addWorktree({ repoName: 'app', localPath: source, worktreesDir: path.join(root, 'run', 'worktrees') })
    fs.writeFileSync(path.join(handle.worktreeRoot, 'package-lock.json'), '{"lockfileVersion":2}')
    const result = await prepareWorktreeDependencies({ handle, runDir: path.join(root, 'run') })
    expect(result).toMatchObject({ verdict: 'incompatible', incompatibilityCause: 'lockfile-mismatch' })
  })

  it.each([
    { config: { mode: 'isolated' as const, prepareCommand: 'exit 1' }, cause: 'prepare-failed' },
    { config: { validateCommand: 'exit 1' }, cause: 'validation-failed' },
    { config: { mode: 'isolated' as const }, cause: 'isolated-dependencies-required' },
  ])('records a stable cause for $cause', async ({ config, cause }) => {
    const handle = await addWorktree({ repoName: 'app', localPath: source, worktreesDir: path.join(root, 'run', 'worktrees') })
    const result = await prepareWorktreeDependencies({ handle, runDir: path.join(root, 'run'), config })
    expect(result).toMatchObject({ verdict: 'incompatible', incompatibilityCause: cause, remediation: expect.any(String) })
  })

  it('does not mutate a shared tree when a repair switches its configuration to isolated mode', async () => {
    fs.mkdirSync(path.join(source, 'node_modules'))
    const handle = await addWorktree({ repoName: 'app', localPath: source, worktreesDir: path.join(root, 'run', 'worktrees') })
    await prepareWorktreeDependencies({ handle, runDir: path.join(root, 'run') })
    const result = await prepareWorktreeDependencies({
      handle, runDir: path.join(root, 'run'),
      config: { mode: 'isolated', prepareCommand: 'touch node_modules/must-not-change' },
    })
    expect(result).toMatchObject({ verdict: 'incompatible', incompatibilityCause: 'isolated-dependencies-required' })
    expect(fs.existsSync(path.join(source, 'node_modules', 'must-not-change'))).toBe(false)
    expect(result.validation).toBeUndefined()
  })

  it.each([
    null, [], { mode: 'invalid' }, { generatorInputs: 'prisma/schema.prisma' },
    { generatorInputs: [null] }, { prepareCommand: '' }, { validateCommand: 42 },
  ])('records malformed preparation as a blocker: %j', async (config) => {
    const handle = await addWorktree({ repoName: 'app', localPath: source, worktreesDir: path.join(root, 'run', 'worktrees') })
    const result = await prepareWorktreeDependencies({ handle, runDir: path.join(root, 'run'), config: config as never })
    expect(result).toMatchObject({ verdict: 'incompatible', incompatibilityCause: 'configuration-invalid' })
    expect(result.validation).toBeUndefined()
  })

  it('records fingerprints from the prepared tree when preparation writes its generator inputs', async () => {
    const handle = await addWorktree({ repoName: 'app', localPath: source, worktreesDir: path.join(root, 'run', 'worktrees') })
    const result = await prepareWorktreeDependencies({
      handle, runDir: path.join(root, 'run'), config: {
        mode: 'isolated', generatorInputs: ['generated-input.json'],
        prepareCommand: 'mkdir -p node_modules && printf ready > generated-input.json',
      },
    })
    expect(result.verdict).toBe('compatible')
    expect(result.generatorInputs[0].sha256).toEqual(expect.any(String))
    expect(result.dependencyGeneratorInputs).toEqual(result.generatorInputs)
    expect(result.dependencyLockfile).toEqual(result.lockfile)
  })
})
