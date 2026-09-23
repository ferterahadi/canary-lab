import fs from 'fs'
import path from 'path'
import { createHash } from 'crypto'
import { atomicWrite } from '../../shared/lib/atomic-write'

type Fingerprints = Record<string, Record<string, string[]>>

export function skillFiles(dir: string, prefix = ''): Record<string, string> | null {
  const files: Record<string, string> = {}
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      const nested = skillFiles(file, rel)
      if (!nested) return null
      Object.assign(files, nested)
    } else if (entry.isFile()) {
      files[rel] = createHash('sha256').update(fs.readFileSync(file)).digest('hex')
    } else {
      // Never follow a user symlink into a different installation or source tree.
      return null
    }
  }
  return files
}

function knownFingerprints(assets: string, homeDir: string): Fingerprints {
  const packaged = JSON.parse(fs.readFileSync(path.join(assets, 'skill-fingerprints.json'), 'utf-8')) as Fingerprints
  const receipt = path.join(homeDir, '.canary-lab', 'agent-integrations', 'skill-fingerprints.json')
  if (fs.existsSync(receipt)) {
    const installed = JSON.parse(fs.readFileSync(receipt, 'utf-8')) as Fingerprints
    for (const [skill, files] of Object.entries(installed)) {
      for (const [file, hashes] of Object.entries(files)) {
        const values = (packaged[skill] ??= {})[file] ??= []
        for (const hash of hashes) if (!values.includes(hash)) values.push(hash)
      }
    }
  }
  return packaged
}

export function isManagedSkill(dir: string, source: string, assets: string, homeDir: string): boolean {
  if (!fs.lstatSync(dir).isDirectory()) return false
  const files = skillFiles(dir)
  if (!files?.['SKILL.md']) return false
  const current = skillFiles(source)!
  const known = knownFingerprints(assets, homeDir)[path.basename(source)] ?? {}
  return Object.entries(files).every(([file, hash]) => current[file] === hash || known[file]?.includes(hash))
}

export function recordManagedSkill(dir: string, homeDir: string): void {
  const file = path.join(homeDir, '.canary-lab', 'agent-integrations', 'skill-fingerprints.json')
  const known: Fingerprints = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf-8')) : {}
  const skill = path.basename(dir)
  for (const [relative, hash] of Object.entries(skillFiles(dir)!)) {
    const hashes = (known[skill] ??= {})[relative] ??= []
    if (!hashes.includes(hash)) hashes.push(hash)
  }
  const content = `${JSON.stringify(known, null, 2)}\n`
  if (!fs.existsSync(file) || fs.readFileSync(file, 'utf-8') !== content) atomicWrite(file, content, 0o600)
}

export function retireLegacySkill(dir: string, homeDir: string): string {
  const backups = path.join(homeDir, '.canary-lab', 'agent-integrations', 'skill-backups')
  fs.mkdirSync(backups, { recursive: true })
  const backup = fs.mkdtempSync(path.join(backups, `${path.basename(dir)}-`))
  fs.renameSync(dir, path.join(backup, path.basename(dir)))
  return backup
}
