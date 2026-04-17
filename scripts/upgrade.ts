import fs from 'fs'
import path from 'path'
import { getProjectRoot } from '../shared/runtime/project-root'

const MARKER_START = '<!-- managed:canary-lab:start -->'
const MARKER_END = '<!-- managed:canary-lab:end -->'

/** Files that are fully managed — overwritten on every upgrade. */
const FULLY_MANAGED: string[] = [
  '.claude/skills/self-fixing-loop.md',
  '.claude/skills/env-import.md',
  '.claude/skills/heal-loop.md',
  '.codex/self-fixing-loop.md',
  '.codex/env-import.md',
  '.codex/heal-loop.md',
]

/** Files where only the content between markers is replaced. */
const MARKER_MANAGED: string[] = [
  'CLAUDE.md',
  'AGENTS.md',
]

/**
 * Known first-line signatures of canary-lab-generated files from pre-marker versions.
 * Used to detect legacy files that should be fully replaced rather than appended to.
 */
const LEGACY_SIGNATURES: Record<string, string> = {
  'CLAUDE.md': '# Canary Lab Project Notes',
  'AGENTS.md': '# Canary Lab Agent Guide',
}

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
 * Replace the managed block in an existing file.
 *
 * Three cases:
 * 1. Markers present → replace content between markers, preserve user content outside
 * 2. No markers, but file starts with a known canary-lab signature → legacy file from
 *    a pre-marker version. Replace the entire file with the managed block (the old
 *    content was all canary-lab-generated anyway)
 * 3. No markers, unknown content → append the managed block after existing content
 */
function applyManagedBlock(existing: string, block: string, relPath: string): string {
  const startIdx = existing.indexOf(MARKER_START)
  const endIdx = existing.indexOf(MARKER_END)

  if (startIdx !== -1 && endIdx !== -1) {
    // Case 1: markers present — surgical replace
    const before = existing.slice(0, startIdx)
    const after = existing.slice(endIdx + MARKER_END.length)
    return before + block + after
  }

  // Check for legacy canary-lab content (pre-marker versions)
  const signature = LEGACY_SIGNATURES[relPath]
  if (signature && existing.trimStart().startsWith(signature)) {
    // Case 2: legacy file — replace entirely
    return block + '\n'
  }

  // Case 3: unknown content — append
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

    const result = applyManagedBlock(existing, managedBlock, relPath)

    // Skip if nothing changed
    if (result === existing) continue

    fs.writeFileSync(targetPath, result)
    log(`  Updated ${relPath} (managed section)`, opts)
    updated += 1
  }

  // 3. Ensure postinstall script exists in project package.json
  const pkgJsonPath = path.join(projectRoot, 'package.json')
  if (fs.existsSync(pkgJsonPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'))
      const scripts = pkg.scripts ?? {}
      if (scripts.postinstall !== 'canary-lab upgrade --silent') {
        scripts.postinstall = 'canary-lab upgrade --silent'
        pkg.scripts = scripts
        fs.writeFileSync(pkgJsonPath, JSON.stringify(pkg, null, 2) + '\n')
        log('  Updated package.json (added postinstall hook)', opts)
        updated += 1
      }
    } catch {
      /* don't break upgrade if package.json is malformed */
    }
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
