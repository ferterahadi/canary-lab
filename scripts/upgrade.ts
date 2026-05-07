import fs from 'fs'
import path from 'path'
import { getProjectRoot } from '../shared/runtime/project-root'
import { getInstalledPackageVersion, writeStamp } from '../shared/runtime/upgrade-check'
import {
  detectMigrations,
  applyArchive,
  renderReport,
  hasPendingMigrations,
  type MigrationReport,
} from './upgrade-migration'

const MARKER_START = '<!-- managed:canary-lab:start -->'
const MARKER_END = '<!-- managed:canary-lab:end -->'

const GITIGNORE_HEADER: string[] = [
  '# Canary Lab envset values may contain secrets.',
  '# envsets.config.json files are outside these patterns, so they stay trackable.',
]
const GITIGNORE_PATTERNS: string[] = [
  'envsets/*/*',
  'features/*/envsets/*/*',
]

/** Files that are fully managed — overwritten on every upgrade. */
const FULLY_MANAGED: string[] = [
  '.claude/skills/env-import.md',
  '.claude/skills/canary-lab-feature.md',
  '.codex/env-import.md',
  '.codex/canary-lab-feature.md',
]

/**
 * Files that used to ship with canary-lab but no longer do. Removed on upgrade
 * so projects scaffolded from older versions don't carry stale copies. Safe to
 * append to; never remove entries (they're how we clean up past installs).
 */
const DEPRECATED: string[] = [
  '.claude/skills/heal-loop.md',
  '.claude/skills/self-fixing-loop.md',
  '.codex/heal-loop.md',
  '.codex/self-fixing-loop.md',
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
export function extractManagedBlock(content: string): string | null {
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
export function applyManagedBlock(existing: string, block: string, relPath: string): string {
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

export function applyGitignoreRules(existing: string): string {
  const lines = existing.split(/\r?\n/)
  const missingPatterns = GITIGNORE_PATTERNS.filter((rule) => !lines.includes(rule))
  if (missingPatterns.length === 0) return existing

  const trimmed = existing.trimEnd()
  return trimmed + (trimmed.length > 0 ? '\n\n' : '') + [...GITIGNORE_HEADER, ...missingPatterns].join('\n') + '\n'
}

interface UpgradeOptions {
  silent: boolean
  check: boolean
  forceArchive: boolean
}

export interface MainExtras {
  /** Injected confirm — called only when there are orphaned logs and
   * `--force-archive` was not passed. Async to support readline prompts. */
  confirm?: (orphanCount: number) => Promise<boolean> | boolean
}

function log(msg: string, opts: UpgradeOptions): void {
  if (!opts.silent) console.log(msg)
}

/**
 * Run the migration pass before the docs/skills sync.
 * Detection is pure; archive is gated by `--force-archive` or `confirm`.
 */
export async function runMigration(
  projectRoot: string,
  opts: UpgradeOptions,
  confirm: (orphanCount: number) => Promise<boolean> | boolean,
): Promise<{ report: MigrationReport; pending: boolean }> {
  const report = detectMigrations(projectRoot)
  const pending = hasPendingMigrations(report)

  if (opts.check) {
    log(renderReport(report), opts)
    return { report, pending }
  }

  if (report.orphanedLogs.length > 0) {
    const ok = opts.forceArchive ? true : await confirm(report.orphanedLogs.length)
    if (ok) applyArchive(report, projectRoot)
  }
  log(renderReport(report), opts)
  return { report, pending }
}

export async function main(
  args = process.argv.slice(2),
  extras: MainExtras = {},
): Promise<void> {
  const opts: UpgradeOptions = {
    silent: args.includes('--silent'),
    check: args.includes('--check'),
    forceArchive: args.includes('--force-archive'),
  }
  const confirm = extras.confirm ?? (() => false)

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

  // 0. 0.9.x → 0.10.x migration pass — detect orphaned logs, lint
  // feature.config.cjs, diff heal-prompt, surface CI hints. Runs before the
  // docs/skills sync so the user sees the report up-front.
  const migration = await runMigration(projectRoot, opts, confirm)
  if (opts.check) {
    if (migration.pending) process.exitCode = 1
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

  // 3. Remove files that used to ship but don't anymore.
  for (const relPath of DEPRECATED) {
    const target = path.join(projectRoot, relPath)
    if (fs.existsSync(target)) {
      fs.unlinkSync(target)
      log(`  Removed deprecated ${relPath}`, opts)
      updated += 1
    }
  }

  // 4. Ensure the envset secret-protection rules exist without replacing
  // user-owned ignore rules.
  const gitignorePath = path.join(projectRoot, '.gitignore')
  const existingGitignore = fs.existsSync(gitignorePath)
    ? fs.readFileSync(gitignorePath, 'utf-8')
    : ''
  const nextGitignore = applyGitignoreRules(existingGitignore)
  if (nextGitignore !== existingGitignore) {
    fs.writeFileSync(gitignorePath, nextGitignore)
    log('  Updated .gitignore (envset value rules)', opts)
    updated += 1
  }

  // 5. Ensure postinstall script exists in project package.json
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

  // Stamp the project with the installed version so the UI can
  // detect drift on future invocations (npm update won't trigger postinstall
  // reliably, so the runner itself nudges users who fall behind).
  const installedVersion = getInstalledPackageVersion()
  if (installedVersion) writeStamp(projectRoot, installedVersion)

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
