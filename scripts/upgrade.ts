import fs from 'fs'
import path from 'path'
import { getProjectRoot } from '../shared/runtime/project-root'

const MARKER_START = '<!-- managed:canary-lab:start -->'
const MARKER_END = '<!-- managed:canary-lab:end -->'

/** Files that are fully managed — overwritten on every upgrade. */
const FULLY_MANAGED: string[] = [
  '.claude/skills/self-fixing-loop.md',
  '.codex/self-fixing-loop.md',
]

/** Files where only the content between markers is replaced. */
const MARKER_MANAGED: string[] = [
  'CLAUDE.md',
  'AGENTS.md',
]

function resolveFirstExisting(pathsToTry: string[]): string {
  const match = pathsToTry.find((candidate) => fs.existsSync(candidate))
  if (!match) {
    throw new Error(`Could not resolve any expected path: ${pathsToTry.join(', ')}`)
  }
  return match
}

function getTemplateRoot(): string {
  return resolveFirstExisting([
    path.resolve(__dirname, '../templates/project'),
    path.resolve(__dirname, '../../templates/project'),
  ])
}

/**
 * Extract the managed block (including markers) from template content.
 * Returns the full block or null if markers are missing.
 */
function extractManagedBlock(content: string): string | null {
  const startIdx = content.indexOf(MARKER_START)
  const endIdx = content.indexOf(MARKER_END)
  if (startIdx === -1 || endIdx === -1) return null
  return content.slice(startIdx, endIdx + MARKER_END.length)
}

/**
 * Replace the managed block in an existing file, or append it if no markers exist.
 */
function applyManagedBlock(existing: string, block: string): string {
  const startIdx = existing.indexOf(MARKER_START)
  const endIdx = existing.indexOf(MARKER_END)

  if (startIdx !== -1 && endIdx !== -1) {
    // Replace existing managed section
    const before = existing.slice(0, startIdx)
    const after = existing.slice(endIdx + MARKER_END.length)
    return before + block + after
  }

  // No markers found — append the managed block
  const trimmed = existing.trimEnd()
  return trimmed + (trimmed.length > 0 ? '\n\n' : '') + block + '\n'
}

interface UpgradeOptions {
  silent: boolean
}

function log(msg: string, opts: UpgradeOptions): void {
  if (!opts.silent) console.log(msg)
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const opts: UpgradeOptions = {
    silent: args.includes('--silent'),
  }

  let projectRoot: string
  try {
    projectRoot = getProjectRoot()
  } catch {
    log('  Could not find Canary Lab project root (no features/ directory found).', opts)
    return
  }

  // Verify this looks like a canary-lab project
  if (!fs.existsSync(path.join(projectRoot, 'features'))) {
    log('  Not a Canary Lab project (no features/ directory). Skipping upgrade.', opts)
    return
  }

  const templateRoot = getTemplateRoot()
  let updated = 0

  // 1. Fully-managed files: overwrite from templates
  for (const relPath of FULLY_MANAGED) {
    const templatePath = path.join(templateRoot, relPath)
    const targetPath = path.join(projectRoot, relPath)

    if (!fs.existsSync(templatePath)) continue

    const templateContent = fs.readFileSync(templatePath, 'utf-8')

    // Skip if contents already match
    if (fs.existsSync(targetPath)) {
      const currentContent = fs.readFileSync(targetPath, 'utf-8')
      if (currentContent === templateContent) continue
    }

    fs.mkdirSync(path.dirname(targetPath), { recursive: true })
    fs.writeFileSync(targetPath, templateContent)
    log(`  Updated ${relPath}`, opts)
    updated += 1
  }

  // 2. Marker-managed files: replace only the managed section
  for (const relPath of MARKER_MANAGED) {
    const templatePath = path.join(templateRoot, relPath)
    const targetPath = path.join(projectRoot, relPath)

    if (!fs.existsSync(templatePath)) continue

    const templateContent = fs.readFileSync(templatePath, 'utf-8')
    const managedBlock = extractManagedBlock(templateContent)
    if (!managedBlock) continue

    const existing = fs.existsSync(targetPath)
      ? fs.readFileSync(targetPath, 'utf-8')
      : ''

    const result = applyManagedBlock(existing, managedBlock)

    // Skip if nothing changed
    if (result === existing) continue

    fs.writeFileSync(targetPath, result)
    log(`  Updated ${relPath} (managed section)`, opts)
    updated += 1
  }

  if (updated > 0) {
    log(`\n  Canary Lab: upgraded ${updated} managed file${updated === 1 ? '' : 's'}.`, opts)
  } else {
    log('  Canary Lab: all managed files are up to date.', opts)
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
