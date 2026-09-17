import { describe, it, expect, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { FeatureConfig } from '../../../../../../../shared/launcher/types'
import { allocateRunPorts, applyFeatureEnvset } from './run-primitives'
import { restore } from './env-switcher/switch'

// applyFeatureEnvset drives the real env-switcher against a throwaway feature
// dir. Nothing here is stubbed: the point is that the run path actually writes
// the slot file to its target and honours the reserved `${port.<slot>}`
// namespace, which a mocked switch layer would not prove.

const tmpDirs: string[] = []
afterEach(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true })
})

/** A feature dir with one `api-env` slot whose set content carries a port token. */
function makeEnvsetFeature(opts: { setContent?: string; existingTarget?: string } = {}): {
  featureDir: string
  targetPath: string
} {
  const featureDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-rp-')))
  tmpDirs.push(featureDir)
  const appRoot = path.join(featureDir, 'app')
  const targetPath = path.join(appRoot, '.env')
  fs.mkdirSync(appRoot, { recursive: true })

  const envSetsDir = path.join(featureDir, 'envsets')
  fs.mkdirSync(path.join(envSetsDir, 'local'), { recursive: true })
  fs.writeFileSync(
    path.join(envSetsDir, 'envsets.config.json'),
    JSON.stringify({
      appRoots: { APP: appRoot },
      slots: { 'api-env': { description: 'api env file', target: '$APP/.env' } },
      feature: { slots: ['api-env'], testCommand: 'true', testCwd: '$APP' },
    }),
  )
  fs.writeFileSync(
    path.join(envSetsDir, 'local', 'api-env'),
    opts.setContent ?? 'PORT=${port.api}\nNAME=canary\n',
  )
  if (opts.existingTarget !== undefined) fs.writeFileSync(targetPath, opts.existingTarget)
  return { featureDir, targetPath }
}

function makeFeature(over: Partial<FeatureConfig> = {}): FeatureConfig {
  return {
    name: 'demo',
    description: 'demo',
    envs: ['local'],
    featureDir: path.join(os.tmpdir(), 'features', 'demo'),
    repos: [{ name: 'api', localPath: os.tmpdir(), startCommands: [{ command: 'echo hi', name: 'api' }] }],
    ...over,
  }
}

describe('allocateRunPorts', () => {
  it('returns undefined when the feature declares no port slots', async () => {
    // No slots → the run keeps whatever ports its commands hardcode.
    await expect(allocateRunPorts(makeFeature(), 'local')).resolves.toBeUndefined()
  })

  it('allocates one free port per declared slot', async () => {
    const feature = makeFeature({
      repos: [{
        name: 'api',
        localPath: os.tmpdir(),
        startCommands: [{
          command: 'serve',
          name: 'api',
          ports: [{ name: 'api', env: 'PORT' }, { name: 'admin', env: 'ADMIN_PORT' }],
        }],
      }],
    })

    const ports = await allocateRunPorts(feature, 'local')

    expect([...ports!.keys()].sort()).toEqual(['admin', 'api'])
    for (const port of ports!.values()) expect(port).toBeGreaterThan(0)
    // Distinct slots must not collide, or two services would fight for a port.
    expect(new Set(ports!.values()).size).toBe(2)
  })
})

describe('applyFeatureEnvset', () => {
  it('returns null when the feature declares no envsets', () => {
    const featureDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-rp-')))
    tmpDirs.push(featureDir)

    expect(applyFeatureEnvset(featureDir, 'local')).toBeNull()
  })

  it('applies the set verbatim when no port map is supplied', () => {
    const { featureDir, targetPath } = makeEnvsetFeature()

    const backups = applyFeatureEnvset(featureDir, 'local')

    expect(backups).toEqual([{ originalPath: targetPath, backupPath: null }])
    // No resolver → the port token survives byte-for-byte (the verify path).
    expect(fs.readFileSync(targetPath, 'utf-8')).toBe('PORT=${port.api}\nNAME=canary\n')
    restore(backups!)
    expect(fs.existsSync(targetPath)).toBe(false)
  })

  it('resolves the reserved port namespace when a port map is supplied', () => {
    const { featureDir, targetPath } = makeEnvsetFeature()

    const backups = applyFeatureEnvset(featureDir, 'local', new Map([['api', 34567]]))

    expect(backups).toEqual([{ originalPath: targetPath, backupPath: null }])
    expect(fs.readFileSync(targetPath, 'utf-8')).toBe('PORT=34567\nNAME=canary\n')
  })

  it('treats an empty port map as no port map', () => {
    const { featureDir, targetPath } = makeEnvsetFeature()

    applyFeatureEnvset(featureDir, 'local', new Map())

    expect(fs.readFileSync(targetPath, 'utf-8')).toBe('PORT=${port.api}\nNAME=canary\n')
  })

  it('backs up a pre-existing target so the run can revert it', () => {
    const { featureDir, targetPath } = makeEnvsetFeature({ existingTarget: 'PORT=3000\n' })

    const backups = applyFeatureEnvset(featureDir, 'local', new Map([['api', 34567]]))

    expect(backups).toHaveLength(1)
    expect(backups![0].originalPath).toBe(targetPath)
    // The backup holds the pre-run content; the target holds the applied set.
    const backupPath = backups![0].backupPath
    expect(backupPath).not.toBeNull()
    expect(fs.readFileSync(backupPath!, 'utf-8')).toBe('PORT=3000\n')
    expect(fs.readFileSync(targetPath, 'utf-8')).toBe('PORT=34567\nNAME=canary\n')
    restore(backups!)
    expect(fs.readFileSync(targetPath, 'utf-8')).toBe('PORT=3000\n')
  })

  it('does not claim a target when the selected envset has no corresponding source', () => {
    const { featureDir, targetPath } = makeEnvsetFeature()
    fs.mkdirSync(path.join(featureDir, 'envsets', 'empty'))
    const backups = applyFeatureEnvset(featureDir, 'empty')
    expect(backups).toEqual([])
    fs.writeFileSync(targetPath, 'USER=value')
    restore(backups!)
    expect(fs.readFileSync(targetPath, 'utf-8')).toBe('USER=value')
  })

  it('unwinds created and overwritten targets when a later slot fails to apply', () => {
    const { featureDir, targetPath } = makeEnvsetFeature()
    const setDir = path.join(featureDir, 'envsets', 'local')
    const existingTarget = path.join(path.dirname(targetPath), 'existing.env')
    const failedTarget = path.join(path.dirname(targetPath), 'failed.env')
    fs.writeFileSync(existingTarget, 'ORIGINAL=value')
    fs.writeFileSync(path.join(setDir, 'second'), 'CHANGED=value')
    // A malformed slot that is a directory fails after both earlier writes.
    fs.mkdirSync(path.join(setDir, 'third'))
    const configPath = path.join(featureDir, 'envsets', 'envsets.config.json')
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
    config.slots.second = { description: 'existing', target: existingTarget }
    config.slots.third = { description: 'invalid', target: failedTarget }
    config.feature.slots.push('second', 'third')
    fs.writeFileSync(configPath, JSON.stringify(config))

    expect(() => applyFeatureEnvset(featureDir, 'local')).toThrow()

    expect(fs.existsSync(targetPath)).toBe(false)
    expect(fs.readFileSync(existingTarget, 'utf-8')).toBe('ORIGINAL=value')
    expect(fs.existsSync(failedTarget)).toBe(false)
    expect(fs.readdirSync(path.dirname(targetPath)).some((name) => name.includes('.bak.'))).toBe(false)
  })
})
