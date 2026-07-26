import { describe, it, expect, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { FeatureConfig } from '../../../../../../../shared/launcher/types'
import { allocateRunPorts, applyFeatureEnvset } from './run-primitives'

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

    expect(backups).toEqual([])
    // No resolver → the port token survives byte-for-byte (the verify path).
    expect(fs.readFileSync(targetPath, 'utf-8')).toBe('PORT=${port.api}\nNAME=canary\n')
  })

  it('resolves the reserved port namespace when a port map is supplied', () => {
    const { featureDir, targetPath } = makeEnvsetFeature()

    const backups = applyFeatureEnvset(featureDir, 'local', new Map([['api', 34567]]))

    expect(backups).toEqual([])
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
    expect(fs.readFileSync(backups![0].backupPath, 'utf-8')).toBe('PORT=3000\n')
    expect(fs.readFileSync(targetPath, 'utf-8')).toBe('PORT=34567\nNAME=canary\n')
  })
})
