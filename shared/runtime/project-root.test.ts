import { describe, it, expect, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { looksLikeProjectRoot, isCanaryLabWorkspace, getProjectRoot, getFeaturesDir } from './project-root'

const tmpDirs: string[] = []
function mkTmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-root-'))
  tmpDirs.push(dir)
  return fs.realpathSync(dir)
}

afterEach(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop()!
    fs.rmSync(d, { recursive: true, force: true })
  }
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('looksLikeProjectRoot', () => {
  it('returns true when features/ exists', () => {
    const dir = mkTmp()
    fs.mkdirSync(path.join(dir, 'features'))
    expect(looksLikeProjectRoot(dir)).toBe(true)
  })

  it('returns false when features/ does not exist', () => {
    expect(looksLikeProjectRoot(mkTmp())).toBe(false)
  })
})

describe('isCanaryLabWorkspace', () => {
  it('returns true when package.json declares a canary-lab dependency', () => {
    for (const block of ['dependencies', 'devDependencies']) {
      const dir = mkTmp()
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ [block]: { 'canary-lab': 'file:x' } }))
      expect(isCanaryLabWorkspace(dir)).toBe(true)
    }
  })

  it('returns true for the canary-lab package itself', () => {
    const dir = mkTmp()
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'canary-lab' }))
    expect(isCanaryLabWorkspace(dir)).toBe(true)
  })

  it('returns false for a stray features/ dir with no package.json (the ~ case)', () => {
    const dir = mkTmp()
    fs.mkdirSync(path.join(dir, 'features'))
    expect(looksLikeProjectRoot(dir)).toBe(true)
    expect(isCanaryLabWorkspace(dir)).toBe(false)
  })

  it('returns false when package.json does not depend on canary-lab', () => {
    const dir = mkTmp()
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'something', dependencies: { lodash: '^4' } }))
    expect(isCanaryLabWorkspace(dir)).toBe(false)
  })

  it('returns false on malformed package.json', () => {
    const dir = mkTmp()
    fs.writeFileSync(path.join(dir, 'package.json'), '{ not json')
    expect(isCanaryLabWorkspace(dir)).toBe(false)
  })
})

describe('getProjectRoot', () => {
  it('returns CANARY_LAB_PROJECT_ROOT when set (resolved)', () => {
    const dir = mkTmp()
    vi.stubEnv('CANARY_LAB_PROJECT_ROOT', dir)
    expect(getProjectRoot()).toBe(path.resolve(dir))
  })

  it('walks upward from cwd to find a directory containing features/', () => {
    const dir = mkTmp()
    const nested = path.join(dir, 'a', 'b', 'c')
    fs.mkdirSync(nested, { recursive: true })
    fs.mkdirSync(path.join(dir, 'features'))
    vi.stubEnv('CANARY_LAB_PROJECT_ROOT', '')
    vi.spyOn(process, 'cwd').mockReturnValue(nested)
    expect(getProjectRoot()).toBe(dir)
  })

  it('falls back to cwd when no features/ is found up the tree', () => {
    const dir = mkTmp()
    const nested = path.join(dir, 'deep')
    fs.mkdirSync(nested, { recursive: true })
    vi.stubEnv('CANARY_LAB_PROJECT_ROOT', '')
    vi.spyOn(process, 'cwd').mockReturnValue(nested)
    expect(getProjectRoot()).toBe(path.resolve(nested))
  })

  it('does not walk above the Canary Lab package checkout', () => {
    const home = mkTmp()
    const checkout = path.join(home, 'Documents', 'canary-lab')
    fs.mkdirSync(path.join(home, 'features'), { recursive: true })
    fs.mkdirSync(checkout, { recursive: true })
    fs.writeFileSync(
      path.join(checkout, 'package.json'),
      JSON.stringify({ name: 'canary-lab' }),
    )
    vi.stubEnv('CANARY_LAB_PROJECT_ROOT', '')
    vi.spyOn(process, 'cwd').mockReturnValue(checkout)
    expect(getProjectRoot()).toBe(checkout)
  })
})

describe('getFeaturesDir', () => {
  it('is <projectRoot>/features', () => {
    const dir = mkTmp()
    vi.stubEnv('CANARY_LAB_PROJECT_ROOT', dir)
    expect(getFeaturesDir()).toBe(path.join(path.resolve(dir), 'features'))
  })
})
