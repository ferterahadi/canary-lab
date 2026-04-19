import { describe, it, expect, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { loadFeatureEnv } from './loadEnv'

const tmpDirs: string[] = []
function mkTmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-env-'))
  tmpDirs.push(dir)
  return dir
}

const SENTINEL = 'CL_TEST_LOAD_ENV_SENTINEL'

afterEach(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop()!
    fs.rmSync(d, { recursive: true, force: true })
  }
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
