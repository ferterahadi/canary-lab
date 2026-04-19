import { describe, it, expect, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  stampPath,
  readStamp,
  writeStamp,
  checkUpgradeDrift,
  formatDriftNotice,
  getInstalledPackageVersion,
} from './upgrade-check'

const tmpDirs: string[] = []
function mkTmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-upgrade-'))
  tmpDirs.push(dir)
  return fs.realpathSync(dir)
}

afterEach(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop()!
    fs.rmSync(d, { recursive: true, force: true })
  }
})

describe('stampPath', () => {
  it('resolves to logs/.canary-lab-version under the project root', () => {
    const dir = mkTmp()
    expect(stampPath(dir)).toBe(path.join(dir, 'logs', '.canary-lab-version'))
  })
})

describe('readStamp / writeStamp', () => {
  it('returns null when no stamp file exists', () => {
    expect(readStamp(mkTmp())).toBeNull()
  })

  it('returns null when the stamp file is empty or whitespace', () => {
    const dir = mkTmp()
    fs.mkdirSync(path.join(dir, 'logs'))
    fs.writeFileSync(stampPath(dir), '   \n')
    expect(readStamp(dir)).toBeNull()
  })

  it('writes and reads back the stamp, creating logs/ as needed', () => {
    const dir = mkTmp()
    writeStamp(dir, '1.2.3')
    expect(fs.existsSync(path.join(dir, 'logs'))).toBe(true)
    expect(readStamp(dir)).toBe('1.2.3')
  })

  it('overwrites a prior stamp', () => {
    const dir = mkTmp()
    writeStamp(dir, '1.0.0')
    writeStamp(dir, '2.0.0')
    expect(readStamp(dir)).toBe('2.0.0')
  })
})

describe('getInstalledPackageVersion', () => {
  it('returns the version field from a package.json', () => {
    const dir = mkTmp()
    const pkgPath = path.join(dir, 'package.json')
    fs.writeFileSync(pkgPath, JSON.stringify({ name: 'x', version: '9.9.9' }))
    expect(getInstalledPackageVersion(pkgPath)).toBe('9.9.9')
  })

  it('returns null when the file is missing or malformed', () => {
    const dir = mkTmp()
    expect(getInstalledPackageVersion(path.join(dir, 'missing.json'))).toBeNull()
    const broken = path.join(dir, 'broken.json')
    fs.writeFileSync(broken, 'not json')
    expect(getInstalledPackageVersion(broken)).toBeNull()
  })

  it('returns null when version is not a string', () => {
    const dir = mkTmp()
    const pkgPath = path.join(dir, 'package.json')
    fs.writeFileSync(pkgPath, JSON.stringify({ name: 'x', version: 123 }))
    expect(getInstalledPackageVersion(pkgPath)).toBeNull()
  })
})

describe('checkUpgradeDrift', () => {
  it('reports drift when no stamp exists (project never upgraded)', () => {
    const state = checkUpgradeDrift(mkTmp(), '0.7.0')
    expect(state).toEqual({ installed: '0.7.0', stamped: null, drift: true })
  })

  it('reports no drift when stamp matches installed', () => {
    const dir = mkTmp()
    writeStamp(dir, '0.7.0')
    expect(checkUpgradeDrift(dir, '0.7.0')).toEqual({
      installed: '0.7.0',
      stamped: '0.7.0',
      drift: false,
    })
  })

  it('reports drift when stamp is older than installed', () => {
    const dir = mkTmp()
    writeStamp(dir, '0.6.0')
    expect(checkUpgradeDrift(dir, '0.7.0')).toEqual({
      installed: '0.7.0',
      stamped: '0.6.0',
      drift: true,
    })
  })

  it('returns drift=false when installed version cannot be determined', () => {
    const dir = mkTmp()
    writeStamp(dir, '0.6.0')
    const state = checkUpgradeDrift(dir, null)
    expect(state.drift).toBe(false)
    expect(state.installed).toBeNull()
  })

  it('does not write a stamp (pure check)', () => {
    const dir = mkTmp()
    checkUpgradeDrift(dir, '0.7.0')
    expect(fs.existsSync(stampPath(dir))).toBe(false)
  })
})

describe('formatDriftNotice', () => {
  it('returns null when there is no drift', () => {
    expect(formatDriftNotice({ installed: '0.7.0', stamped: '0.7.0', drift: false })).toBeNull()
  })

  it('returns null when installed version is unknown', () => {
    expect(formatDriftNotice({ installed: null, stamped: '0.6.0', drift: true })).toBeNull()
  })

  it('mentions the stamped version when present', () => {
    const msg = formatDriftNotice({ installed: '0.7.0', stamped: '0.6.0', drift: true })
    expect(msg).toContain('0.7.0')
    expect(msg).toContain('0.6.0')
    expect(msg).toContain('npx canary-lab upgrade')
  })

  it('mentions "never synced" when no stamp exists', () => {
    const msg = formatDriftNotice({ installed: '0.7.0', stamped: null, drift: true })
    expect(msg).toContain('never been synced')
    expect(msg).toContain('0.7.0')
    expect(msg).toContain('npx canary-lab upgrade')
  })
})
