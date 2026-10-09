import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildAppRoots,
  getEnvSetsDir,
  getSlotFilesInSet,
  loadConfig,
  resolveSetTargets,
  resolveVars,
  selectedEnvsetSources,
  selectedEnvsetTargets,
  type EnvSetsConfig,
} from './envset-runtime'
import * as compatibility from '../../runs/logic/runtime/env-switcher/switch'
import { applyFeatureEnvset } from '../../runs/logic/runtime/run-primitives'
import { hydrateEnvsetIntoWorktrees } from '../../runs/logic/runtime/env-switcher/worktree-hydrate'
import { envsetProcessEnv } from './envset-process-env'
import { trackTempDirs } from '../../../../../../tools/test-helpers/temp-dir'

const tempDir = trackTempDirs('cl-envset-runtime-')

let root: string
let featureDir: string
let envsetsDir: string
beforeEach(() => {
  root = tempDir()
  featureDir = path.join(root, 'features', 'example')
  envsetsDir = path.join(featureDir, 'envsets')
  fs.mkdirSync(path.join(envsetsDir, 'local'), { recursive: true })
  vi.stubEnv('CANARY_LAB_PROJECT_ROOT', root)
})
afterEach(() => { vi.unstubAllEnvs() })

function seed(target = '$CANARY_LAB/features/example/.env'): EnvSetsConfig {
  const config = { appRoots: {}, slots: { 'app.env': { description: 'fixture', target } }, feature: { slots: ['app.env'], testCommand: 'true', testCwd: '$CANARY_LAB/features/example' } }
  save(config)
  fs.writeFileSync(path.join(envsetsDir, 'local', 'app.env'), 'TOKEN=fixture\nPORT=${port.api}\n')
  return config
}
function save(config: unknown): void { fs.writeFileSync(path.join(envsetsDir, 'envsets.config.json'), JSON.stringify(config)) }

describe('envset runtime resolution', () => {
  it('seeds both aliases and lets explicit overrides replace them independently', () => {
    expect(buildAppRoots({})).toEqual({ CANARY_LAB: root, CANARY_LAB_PROJECT_ROOT: root })
    expect(buildAppRoots({ appRoots: { CANARY_LAB: '/alias', OTHER: '/other' } })).toEqual({ CANARY_LAB: '/alias', CANARY_LAB_PROJECT_ROOT: root, OTHER: '/other' })
    expect(buildAppRoots({ appRoots: { CANARY_LAB_PROJECT_ROOT: '/project' } })).toEqual({ CANARY_LAB: root, CANARY_LAB_PROJECT_ROOT: '/project' })
  })
  it('preserves variable grammar, repeated expansion, empty values, and unknown variables', () => {
    expect(resolveVars('$KNOWN/$KNOWN/$UNKNOWN/$empty/${port.api}/$EMPTY/$A1', { KNOWN: 'ok', EMPTY: '', A: 'a' })).toBe('ok/ok/$UNKNOWN/$empty/${port.api}//a1')
  })
  it('locates named and absolute linked suites without changing path rules', () => {
    expect(getEnvSetsDir('example')).toBe(envsetsDir)
    expect(getEnvSetsDir(path.join(root, 'linked'))).toBe(path.join(root, 'linked', 'envsets'))
  })
  it.each(['CANARY_LAB', 'CANARY_LAB_PROJECT_ROOT'])('uses the displayed %s target for application and restoration', (alias) => {
    const config = seed(`$${alias}/features/example/.env`)
    const displayed = resolveVars(config.slots['app.env'].target, buildAppRoots(config))
    expect(displayed).toBe(path.join(featureDir, '.env'))
    expect(resolveSetTargets(featureDir, 'local')).toEqual([{ slot: 'app.env', targetPath: displayed }])
    const backups = applyFeatureEnvset(featureDir, 'local')!
    expect(fs.readFileSync(displayed, 'utf8')).toBe('TOKEN=fixture\nPORT=${port.api}\n')
    expect(fs.existsSync(path.join(root, `$${alias}`))).toBe(false)
    compatibility.restore(backups)
    expect(fs.existsSync(displayed)).toBe(false)
  })
  it('honors explicit targets and rereads changed metadata', () => {
    const config = seed()
    const override = path.join(root, 'pinned')
    config.appRoots = { CANARY_LAB: override }
    save(config)
    expect(resolveSetTargets(featureDir, 'local')[0].targetPath).toBe(path.join(override, 'features/example/.env'))
    config.slots['app.env'].target = path.join(root, 'absolute.env')
    save(config)
    expect(resolveSetTargets(featureDir, 'local')[0].targetPath).toBe(path.join(root, 'absolute.env'))
  })
  it('preserves declaration order and duplicates while ignoring absent sources', () => {
    const config = seed()
    config.feature.slots = ['missing', 'app.env', 'app.env']
    save(config)
    expect(getSlotFilesInSet(envsetsDir, 'local', config.feature.slots)).toEqual(['app.env', 'app.env'])
    expect(Array.from(selectedEnvsetTargets(envsetsDir, 'local', loadConfig(featureDir)))).toEqual([
      { slot: 'app.env', sourcePath: path.join(envsetsDir, 'local', 'app.env'), targetPath: path.join(featureDir, '.env') },
      { slot: 'app.env', sourcePath: path.join(envsetsDir, 'local', 'app.env'), targetPath: path.join(featureDir, '.env') },
    ])
    expect(Array.from(selectedEnvsetSources(envsetsDir, 'absent', config.feature.slots))).toEqual([])
  })
  it('selects sources by existence, including directories, and leaves read failures to callers', () => {
    fs.mkdirSync(path.join(envsetsDir, 'local', 'directory'))
    expect(getSlotFilesInSet(envsetsDir, 'local', ['directory'])).toEqual(['directory'])
  })
  it('keeps missing metadata strict for loading and optional for target resolution', () => {
    expect(() => loadConfig(featureDir)).toThrow(`Missing envsets config for "${featureDir}"`)
    expect(resolveSetTargets(featureDir, 'local')).toEqual([])
    expect(resolveSetTargets(path.join(root, 'missing'), 'local')).toEqual([])
  })
  it('propagates malformed JSON and filesystem read errors without HTTP translation', () => {
    const file = path.join(envsetsDir, 'envsets.config.json')
    fs.writeFileSync(file, '{')
    expect(() => loadConfig(featureDir)).toThrow(SyntaxError)
    fs.rmSync(file)
    fs.mkdirSync(file)
    expect(() => loadConfig(featureDir)).toThrow(/EISDIR/)
  })
  it.each([null, 1, 'text'])('retains runtime failure on metadata %j', (value) => {
    save(value)
    expect(() => loadConfig(featureDir)).toThrow(TypeError)
  })
  it('does not add nested validation to runtime loading', () => {
    save({})
    expect(loadConfig(featureDir)).toEqual({ appRoots: buildAppRoots({}) })
    expect(() => resolveSetTargets(featureDir, 'local')).toThrow(TypeError)
  })
  it('lets discovery read present sources without target definitions', () => {
    seed()
    save({ feature: { slots: ['missing', 'app.env'] }, slots: {} })
    const warn = vi.fn()
    expect(envsetProcessEnv(featureDir, 'local', warn)).toEqual({ TOKEN: 'fixture', PORT: '${port.api}' })
    expect(warn).not.toHaveBeenCalled()
  })
  it.each(['CANARY_LAB', 'CANARY_LAB_PROJECT_ROOT'])('hydrates the %s target with the same port transform and restores prior bytes', (alias) => {
    seed(`$${alias}/features/example/.env`)
    const worktreeRoot = path.join(root, 'worktree')
    fs.mkdirSync(worktreeRoot)
    const prior = 'ORIGINAL=yes\n'
    fs.writeFileSync(path.join(worktreeRoot, '.env'), prior)
    const resolve = (content: string) => content.replace('${port.api}', '4100')
    const applied = applyFeatureEnvset(featureDir, 'local', new Map([['api', 4100]]))!
    const hydrated = hydrateEnvsetIntoWorktrees({ featureDir, setName: 'local', roots: [{ sourceRoot: featureDir, worktreeRoot }], resolve })
    expect(hydrated.written).toEqual([path.join(worktreeRoot, '.env')])
    expect(fs.readFileSync(hydrated.written[0])).toEqual(fs.readFileSync(path.join(featureDir, '.env')))
    hydrated.restore()
    compatibility.restore(applied)
    expect(fs.readFileSync(path.join(worktreeRoot, '.env'), 'utf8')).toBe(prior)
    expect(fs.existsSync(path.join(featureDir, '.env'))).toBe(false)
  })
  it('restores duplicate worktree targets in reverse write order', () => {
    const config = seed()
    config.slots.second = { description: 'same target', target: config.slots['app.env'].target }
    config.feature.slots.push('second')
    save(config)
    fs.writeFileSync(path.join(envsetsDir, 'local', 'second'), 'SECOND=yes')
    const worktreeRoot = path.join(root, 'worktree')
    fs.mkdirSync(worktreeRoot)
    const target = path.join(worktreeRoot, '.env')
    fs.writeFileSync(target, 'ORIGINAL=yes')
    const hydrated = hydrateEnvsetIntoWorktrees({ featureDir, setName: 'local', roots: [{ sourceRoot: featureDir, worktreeRoot }] })
    expect(hydrated.written).toEqual([target, target])
    expect(fs.readFileSync(target, 'utf8')).toBe('SECOND=yes')
    hydrated.restore()
    expect(fs.readFileSync(target, 'utf8')).toBe('ORIGINAL=yes')
  })
  it('resolves all normal-run targets before taking backups', () => {
    const config = seed()
    config.feature.slots.push('invalid')
    save(config)
    fs.writeFileSync(path.join(envsetsDir, 'local', 'invalid'), 'LATER=yes')
    fs.writeFileSync(path.join(featureDir, '.env'), 'ORIGINAL=yes')
    expect(() => applyFeatureEnvset(featureDir, 'local')).toThrow(TypeError)
    expect(fs.readFileSync(path.join(featureDir, '.env'), 'utf8')).toBe('ORIGINAL=yes')
    expect(fs.readdirSync(featureDir).filter((name) => name.includes('.bak.'))).toEqual([])
  })
  it('keeps an earlier hydration write when a later target cannot resolve', () => {
    const config = seed()
    config.feature.slots.push('invalid')
    save(config)
    fs.writeFileSync(path.join(envsetsDir, 'local', 'invalid'), 'LATER=yes')
    const worktreeRoot = path.join(root, 'worktree')
    expect(() => hydrateEnvsetIntoWorktrees({ featureDir, setName: 'local', roots: [{ sourceRoot: featureDir, worktreeRoot }] })).toThrow(TypeError)
    expect(fs.readFileSync(path.join(worktreeRoot, '.env'), 'utf8')).toBe('TOKEN=fixture\nPORT=${port.api}\n')
  })
})
