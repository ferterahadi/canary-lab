import { describe, it, expect, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import { loadFeatureEnv } from './loadEnv'
import { trackTempDirs } from '../../tools/test-helpers/temp-dir'

const mkTmp = trackTempDirs('cl-env-')

const SENTINEL = 'CL_TEST_LOAD_ENV_SENTINEL'

afterEach(() => {
  delete process.env[SENTINEL]
})

describe('loadFeatureEnv', () => {
  it('loads variables from <featureDir>/.env into process.env', () => {
    const dir = mkTmp()
    fs.writeFileSync(path.join(dir, '.env'), `${SENTINEL}=hello\n`)
    expect(process.env[SENTINEL]).toBeUndefined()
    loadFeatureEnv(dir)
    expect(process.env[SENTINEL]).toBe('hello')
  })

  it('is a no-op when .env does not exist', () => {
    const dir = mkTmp()
    expect(() => loadFeatureEnv(dir)).not.toThrow()
    expect(process.env[SENTINEL]).toBeUndefined()
  })

  it('does not overwrite an already-set env var (dotenv default)', () => {
    const dir = mkTmp()
    process.env[SENTINEL] = 'preset'
    fs.writeFileSync(path.join(dir, '.env'), `${SENTINEL}=loaded\n`)
    loadFeatureEnv(dir)
    expect(process.env[SENTINEL]).toBe('preset')
  })
})
