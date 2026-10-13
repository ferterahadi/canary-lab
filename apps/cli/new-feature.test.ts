import fs from 'fs'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { canonicalScaffoldPaths } from '../../shared/feature-scaffold'
import { trackTempDirs } from '../../tools/test-helpers/temp-dir'

const tempDir = trackTempDirs('new-feature-')
let tmp: string

beforeEach(() => {
  tmp = tempDir()
  fs.mkdirSync(path.join(tmp, 'features'), { recursive: true })
  vi.stubEnv('CANARY_LAB_PROJECT_ROOT', tmp)
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('canary-lab new feature', () => {
  it('creates the canonical scaffold files', async () => {
    const { main } = await import('./new-feature')
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    await main(['demo_login', '--description', 'Demo login'])
    logSpy.mockRestore()

    const featureDir = path.join(tmp, 'features', 'demo_login')
    expect(canonicalScaffoldPaths('demo_login').map((rel) => fs.existsSync(path.join(featureDir, rel)))).toEqual(
      canonicalScaffoldPaths('demo_login').map(() => true),
    )
    expect(fs.readFileSync(path.join(featureDir, 'feature.config.cjs'), 'utf8')).toContain("description: 'Demo login'")
  })
})
