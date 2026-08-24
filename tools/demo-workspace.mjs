import fs from 'fs'
import os from 'os'
import path from 'path'

export const DEMO_DIRECTORY_NAME = 'Canary Lab Demos'
export const DEMO_ROOT_PREFIX = 'canary-lab-demo-'

export function parseDemoCleanupArgs(argv) {
  const options = { force: false, olderThanDays: 0 }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--force') {
      options.force = true
      continue
    }
    if (arg === '--older-than') {
      const value = Number(argv[++index])
      if (Number.isFinite(value) && value >= 0) {
        options.olderThanDays = value
        continue
      }
    }
    throw new Error('Usage: npm run demo:clean -- [--older-than <days>] [--force]')
  }
  return options
}

export function demoDirectory(homeDir = os.homedir()) {
  return path.join(homeDir, DEMO_DIRECTORY_NAME)
}

export function createDemoRoot({ persistent, homeDir = os.homedir(), tempDir = os.tmpdir() }) {
  const parent = persistent ? demoDirectory(homeDir) : tempDir
  fs.mkdirSync(parent, { recursive: true })
  return fs.mkdtempSync(path.join(parent, DEMO_ROOT_PREFIX))
}

export function referencedDemoRoots(homeDir = os.homedir()) {
  const parent = demoDirectory(homeDir)
  const registryDir = path.join(homeDir, '.canary-lab')
  const files = [
    ['active-servers.json', 'servers', 'projectRoot'],
    ['workspaces.json', 'workspaces', 'path'],
  ]
  const referenced = new Set()

  for (const [file, listKey, pathKey] of files) {
    const target = path.join(registryDir, file)
    if (!fs.existsSync(target)) continue
    let entries
    try {
      entries = JSON.parse(fs.readFileSync(target, 'utf-8'))?.[listKey]
    } catch (error) {
      throw new Error(`Refusing to clean while ${target} is unreadable: ${error.message}`)
    }
    if (!Array.isArray(entries)) {
      throw new Error(`Refusing to clean while ${target} has an unexpected format`)
    }
    for (const entry of entries) {
      if (typeof entry?.[pathKey] !== 'string') continue
      const relative = path.relative(parent, path.resolve(entry[pathKey]))
      const rootName = relative.split(path.sep)[0]
      if (relative.startsWith('..') || path.isAbsolute(relative) || !rootName.startsWith(DEMO_ROOT_PREFIX)) continue
      referenced.add(path.join(parent, rootName))
    }
  }
  return referenced
}

export function removeDemoRoots({
  homeDir = os.homedir(),
  olderThanDays = 0,
  now = Date.now(),
  protectedRoots = new Set(),
} = {}) {
  if (!Number.isFinite(olderThanDays) || olderThanDays < 0) {
    throw new Error('--older-than must be a non-negative number of days')
  }

  const parent = demoDirectory(homeDir)
  if (!fs.existsSync(parent)) return { removed: [], skipped: [] }

  const parentStat = fs.lstatSync(parent)
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    throw new Error(`Refusing to clean an unexpected demo directory: ${parent}`)
  }

  const cutoff = now - olderThanDays * 24 * 60 * 60 * 1000
  const removed = []
  const skipped = []
  for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
    if (!entry.name.startsWith(DEMO_ROOT_PREFIX) || !entry.isDirectory() || entry.isSymbolicLink()) continue
    const target = path.join(parent, entry.name)
    if (olderThanDays > 0 && fs.statSync(target).mtimeMs > cutoff) continue
    if (protectedRoots.has(target)) {
      skipped.push(target)
      continue
    }
    fs.rmSync(target, { recursive: true, force: true })
    removed.push(target)
  }
  return { removed, skipped }
}
