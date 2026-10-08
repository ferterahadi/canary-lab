import fs from 'fs'
import path from 'path'
import { beforeEach, expect, it } from 'vitest'
import { readFeatureConfig } from '../../../shared/config-ast'
import type { WorkspaceEventPublisher } from '../../../shared/workspace-events'
import { removeEnvironment } from './envset-removal'
import { trackTempDirs } from '../../../../../../tools/test-helpers/temp-dir'

const tempDir = trackTempDirs('cl-env-removal-')

let dir: string
let config: string
let events: Array<{ type: string; feature?: string }>
let publisher: WorkspaceEventPublisher
beforeEach(() => {
  dir = tempDir()
  config = path.join(dir, 'feature.config.cjs')
  fs.writeFileSync(config, "// Preserve this comment\nmodule.exports = { config: { name: 'renamed', envs: ['staging', 'stale'] } }\n")
  for (const env of ['staging', 'local', 'dev']) fs.mkdirSync(path.join(dir, 'envsets', env), { recursive: true })
  fs.writeFileSync(path.join(dir, 'envsets', 'envsets.config.json'), 'null')
  events = []
  publisher = { publish: (event) => { events.push(event) } }
})
const declaredEnvs = () => readFeatureConfig(fs.readFileSync(config, 'utf8')).value.envs
const remove = (env: string) => removeEnvironment({ feature: 'renamed', featureDir: dir, workspaceEvents: publisher }, env)

it('synchronizes sorted folders before publishing the ordered structural change for the suite identity', () => {
  publisher = { publish: (event) => {
    expect(declaredEnvs()).toEqual(['dev', 'local'])
    expect(fs.existsSync(path.join(dir, 'envsets', 'staging'))).toBe(false)
    events.push(event)
  } }
  expect(remove('staging')).toBe('removed')
  expect(events).toEqual([{ type: 'envsets-changed', feature: 'renamed' }, { type: 'features-changed' }])
  expect(fs.readFileSync(config, 'utf8')).toContain('// Preserve this comment')
  expect(fs.readFileSync(path.join(dir, 'envsets', 'envsets.config.json'), 'utf8')).toBe('null')
})

it('persists an empty list after the last environment and leaves an absent environment unchanged', () => {
  for (const env of ['dev', 'local', 'staging']) expect(remove(env)).toBe('removed')
  expect(declaredEnvs()).toEqual([])
  const bytes = fs.readFileSync(config, 'utf8')
  events.length = 0
  expect(remove('staging')).toBe('missing')
  expect(fs.readFileSync(config, 'utf8')).toBe(bytes)
  expect(events).toEqual([])
})

it.each(['', '.', 'local/..', '..', '../../outside'])('refuses root or escaped target %j without writes or events', (env) => {
  const bytes = fs.readFileSync(config, 'utf8')
  expect(remove(env)).toBe('invalid')
  expect(fs.readdirSync(path.join(dir, 'envsets')).sort()).toEqual(['dev', 'envsets.config.json', 'local', 'staging'])
  expect(fs.readFileSync(config, 'utf8')).toBe(bytes)
  expect(events).toEqual([])
})

it('removes pre-scaffold environments without a suite config or publisher', () => {
  fs.rmSync(config)
  expect(removeEnvironment({ feature: 'renamed', featureDir: dir }, 'local')).toBe('removed')
  expect(fs.existsSync(path.join(dir, 'envsets', 'local'))).toBe(false)
  expect(fs.existsSync(config)).toBe(false)
})

it('propagates directory removal failures without announcing success', () => {
  // A non-writable parent makes removal fail on the real filesystem.
  const envsets = path.join(dir, 'envsets')
  const bytes = fs.readFileSync(config, 'utf8')
  fs.chmodSync(envsets, 0o555)
  try {
    expect(() => remove('local')).toThrow()
    expect(fs.existsSync(path.join(envsets, 'local'))).toBe(true)
    expect(fs.readFileSync(config, 'utf8')).toBe(bytes)
    expect(events).toEqual([])
  } finally { fs.chmodSync(envsets, 0o755) }
})

it('does not roll back removal or publish success when the subsequent config read fails', () => {
  fs.rmSync(config)
  fs.mkdirSync(config)
  expect(() => remove('local')).toThrow(expect.objectContaining({ code: 'EISDIR' }))
  expect(fs.existsSync(path.join(dir, 'envsets', 'local'))).toBe(false)
  expect(events).toEqual([])
})
