/**
 * 0.9.x → 0.10.x migration: detect orphaned top-level logs, lint
 * feature.config.cjs files for dropped fields, diff the heal-prompt block
 * against the bundled template, and surface CI scripts that reference
 * old paths. Pure detection + report rendering; the destructive archive
 * step is exposed separately so callers can show the report before
 * doing anything irreversible.
 */
import fs from 'fs'
import path from 'path'
import { execFileSync } from 'child_process'
import { KNOWN_OLD_HEAL_PROMPTS } from './upgrade-known-prompts'

export type HealPromptStatus =
  | 'matches-current'
  | 'matches-old-exact'
  | 'customized'

export interface CiPathHint {
  file: string
  line: number
  content: string
}

export interface StaleFeatureConfig {
  path: string
  issues: string[]
}

export interface MigrationReport {
  archivedFiles: string[]
  staleFeatureConfigs: StaleFeatureConfig[]
  healPromptStatus: HealPromptStatus
  healPromptDiff?: string
  ciPathHints: CiPathHint[]
  /** Raw paths that would be archived (input to applyArchive). Same as
   * archivedFiles before applyArchive runs. */
  orphanedLogs: string[]
  /** Marker note when CLAUDE.md exists but lacks the heal-prompt markers. */
  healPromptNote?: string
}

const ORPHAN_TOP_LEVEL_FILES = new Set([
  'heal-index.md',
  'e2e-summary.json',
  'manifest.json',
])

/** Find orphaned 0.9.x log files at top level of `logs/`. */
export function findOrphanedLogs(repoRoot: string): string[] {
  const logsDir = path.join(repoRoot, 'logs')
  if (!fs.existsSync(logsDir)) return []
  const out: string[] = []
  for (const entry of fs.readdirSync(logsDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue
    const name = entry.name
    if (name === 'diagnosis-journal.md') continue
    if (name.startsWith('svc-') && name.endsWith('.log')) {
      out.push(path.join(logsDir, name))
      continue
    }
    if (ORPHAN_TOP_LEVEL_FILES.has(name)) {
      out.push(path.join(logsDir, name))
    }
  }
  return out.sort()
}

/** Lint a single feature.config.cjs file. Returns issue list (empty if clean). */
export function lintFeatureConfig(configPath: string): string[] {
  const issues: string[] = []
  let mod: any
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    delete require.cache[require.resolve(configPath)]
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    mod = require(configPath)
  } catch (err) {
    issues.push(`failed to load: ${(err as Error).message}`)
    return issues
  }
  const cfg = mod?.config ?? mod?.default ?? mod
  if (!cfg || typeof cfg !== 'object') {
    issues.push('export is not an object')
    return issues
  }
  if ('launcher' in cfg) {
    issues.push(`dropped field: launcher: ${JSON.stringify(cfg.launcher)} (silently ignored in 0.10.x)`)
  }
  if (!('description' in cfg) || typeof cfg.description !== 'string' || cfg.description.length === 0) {
    issues.push('missing field: description')
  }
  if (!('envs' in cfg) || !Array.isArray(cfg.envs)) {
    issues.push('missing field: envs')
  }
  return issues
}

/** Walk features/ and lint each feature.config.cjs. */
export function findStaleFeatureConfigs(repoRoot: string): StaleFeatureConfig[] {
  const featuresDir = path.join(repoRoot, 'features')
  if (!fs.existsSync(featuresDir)) return []
  const out: StaleFeatureConfig[] = []
  for (const entry of fs.readdirSync(featuresDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const cfgPath = path.join(featuresDir, entry.name, 'feature.config.cjs')
    if (!fs.existsSync(cfgPath)) continue
    const issues = lintFeatureConfig(cfgPath)
    if (issues.length > 0) {
      out.push({ path: cfgPath, issues })
    }
  }
  return out
}

/** Extract heal-prompt body (between markers, trimmed). Returns null if markers missing. */
export function extractHealPrompt(content: string): string | null {
  const start = content.indexOf('<!-- heal-prompt:start -->')
  const end = content.indexOf('<!-- heal-prompt:end -->')
  if (start === -1 || end === -1 || end < start) return null
  const body = content.slice(start + '<!-- heal-prompt:start -->'.length, end)
  return body.trim()
}

export interface HealPromptComparison {
  status: HealPromptStatus
  diff?: string
  note?: string
}

/** Simple line-level diff: '- ' for current, '+ ' for template lines. */
function renderHealDiff(current: string, template: string): string {
  const out: string[] = []
  out.push('--- current CLAUDE.md heal-prompt')
  out.push('+++ template heal-prompt (0.10.x)')
  for (const ln of current.split('\n')) out.push(`- ${ln}`)
  for (const ln of template.split('\n')) out.push(`+ ${ln}`)
  return out.join('\n')
}

/**
 * Compare a project's heal-prompt block against the bundled template's body.
 * `currentClaudeMd` is the user's CLAUDE.md contents (may be ''); `templateBody`
 * is the trimmed template body extracted by the caller.
 */
export function compareHealPrompt(
  currentClaudeMd: string,
  templateBody: string,
): HealPromptComparison {
  if (currentClaudeMd.length === 0) {
    // No CLAUDE.md yet (fresh install) — treat as up-to-date; the docs/skills
    // sync that runs after migration will create it from the template.
    return { status: 'matches-current' }
  }
  const current = extractHealPrompt(currentClaudeMd)
  if (current === null) {
    return {
      status: 'customized',
      note: 'CLAUDE.md is missing the <!-- heal-prompt:start --> / <!-- heal-prompt:end --> markers.',
    }
  }
  const tplTrimmed = templateBody.trim()
  if (current === tplTrimmed) return { status: 'matches-current' }
  for (const known of KNOWN_OLD_HEAL_PROMPTS) {
    if (current === known.body.trim()) {
      return {
        status: 'matches-old-exact',
        diff: renderHealDiff(current, tplTrimmed),
      }
    }
  }
  return { status: 'customized', diff: renderHealDiff(current, tplTrimmed) }
}

/**
 * Parse `grep -rn` output into structured CI hints. One match per line of the
 * form `path:line:content`. Lines that don't match the shape are skipped.
 */
export function findOldPathReferences(grepOutput: string): CiPathHint[] {
  if (!grepOutput) return []
  const out: CiPathHint[] = []
  for (const raw of grepOutput.split('\n')) {
    if (!raw) continue
    // Skip grep noise like "Binary file X matches" or trailing blank
    if (raw.startsWith('Binary file ')) continue
    // Format: path:line:content (path may contain colons on windows, but
    // we're on posix; first two colons split path/line/content)
    const firstColon = raw.indexOf(':')
    if (firstColon === -1) continue
    const secondColon = raw.indexOf(':', firstColon + 1)
    if (secondColon === -1) continue
    const file = raw.slice(0, firstColon)
    const lineStr = raw.slice(firstColon + 1, secondColon)
    const lineNum = Number(lineStr)
    if (!Number.isFinite(lineNum) || lineNum <= 0) continue
    const content = raw.slice(secondColon + 1)
    out.push({ file, line: lineNum, content })
  }
  return out
}

/** Run grep across the repo and parse the result. Skips noise dirs. */
function gatherCiPathHints(repoRoot: string): CiPathHint[] {
  // Use a single fixed-string regex; `--include` repeated for each glob.
  const pattern = 'logs/heal-index.md\\|logs/svc-\\|logs/e2e-summary.json'
  const args = [
    '-rn',
    '--include=*.sh',
    '--include=*.yml',
    '--include=*.yaml',
    '--include=Makefile',
    '--include=*.json',
    '--exclude-dir=node_modules',
    '--exclude-dir=dist',
    '--exclude-dir=coverage',
    '--exclude-dir=_pre-0.10.x-archive',
    '--exclude-dir=.git',
    pattern,
    '.',
  ]
  let output = ''
  try {
    output = execFileSync('grep', args, {
      cwd: repoRoot,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 4 * 1024 * 1024,
    })
  } catch {
    // grep exits 1 when no matches; any other failure is treated the same —
    // we'd rather render an empty CI hints section than crash the upgrade.
    output = ''
  }
  // Strip leading "./" from paths for nicer display.
  const cleaned = output
    .split('\n')
    .map((ln) => (ln.startsWith('./') ? ln.slice(2) : ln))
    .join('\n')
  return findOldPathReferences(cleaned)
}

function loadTemplateHealPrompt(): string {
  const candidates = [
    path.resolve(__dirname, '../templates/project/CLAUDE.md'),
    path.resolve(__dirname, '../../templates/project/CLAUDE.md'),
  ]
  const found = candidates.find((c) => fs.existsSync(c))
  if (!found) return ''
  return extractHealPrompt(fs.readFileSync(found, 'utf-8')) ?? ''
}

export interface DetectMigrationsOptions {
  /** Override the bundled template body (test injection). */
  templateHealPromptBody?: string
}

export function detectMigrations(
  repoRoot: string,
  opts: DetectMigrationsOptions = {},
): MigrationReport {
  const orphanedLogs = findOrphanedLogs(repoRoot)
  const staleFeatureConfigs = findStaleFeatureConfigs(repoRoot)

  const claudeMdPath = path.join(repoRoot, 'CLAUDE.md')
  const claudeMd = fs.existsSync(claudeMdPath)
    ? fs.readFileSync(claudeMdPath, 'utf-8')
    : ''
  const templateBody = opts.templateHealPromptBody ?? loadTemplateHealPrompt()
  const heal = compareHealPrompt(claudeMd, templateBody)

  const ciPathHints = gatherCiPathHints(repoRoot)

  return {
    archivedFiles: [],
    orphanedLogs,
    staleFeatureConfigs,
    healPromptStatus: heal.status,
    healPromptDiff: heal.diff,
    healPromptNote: heal.note,
    ciPathHints,
  }
}

/**
 * Atomically rename each orphaned log file into a timestamped archive dir
 * under `logs/_pre-0.10.x-archive/`. Mutates `report.archivedFiles` to record
 * the destination paths so the renderer can show the user where things went.
 */
export function applyArchive(report: MigrationReport, repoRoot: string): void {
  if (report.orphanedLogs.length === 0) return
  const ts = nowIso()
  const archiveDir = path.join(
    repoRoot,
    'logs',
    '_pre-0.10.x-archive',
    ts,
  )
  fs.mkdirSync(archiveDir, { recursive: true })
  for (const src of report.orphanedLogs) {
    const dest = path.join(archiveDir, path.basename(src))
    fs.renameSync(src, dest)
    report.archivedFiles.push(dest)
  }
}

/** Filesystem-safe ISO timestamp: `YYYY-MM-DDTHHMM`. */
function nowIso(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`
  )
}

/** Format a byte count as a friendly size string (KB / MB). */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** Render the migration report as plain text suitable for stdout. */
export function renderReport(report: MigrationReport): string {
  const lines: string[] = []
  lines.push('canary-lab upgrade — 0.9.x → 0.10.x migration')
  lines.push('')

  // Orphaned logs section
  if (report.archivedFiles.length > 0) {
    lines.push(`✓ Archived ${report.archivedFiles.length} orphaned log file(s):`)
    for (const dest of report.archivedFiles) {
      lines.push(`   - ${dest}`)
    }
  } else if (report.orphanedLogs.length > 0) {
    lines.push(`⚠  Found ${report.orphanedLogs.length} orphaned 0.9.x log file(s) at top level of logs/:`)
    for (const src of report.orphanedLogs) {
      let size = 0
      try {
        size = fs.statSync(src).size
      } catch {
        /* ignore */
      }
      lines.push(`   - ${src} (${formatSize(size)})`)
    }
    lines.push('   These will be moved to logs/_pre-0.10.x-archive/<ts>/ if you confirm.')
  } else {
    lines.push('✓ No orphaned 0.9.x logs at top level of logs/.')
  }
  lines.push('')

  // feature.config.cjs lint
  if (report.staleFeatureConfigs.length > 0) {
    lines.push(`⚠  ${report.staleFeatureConfigs.length} feature.config.cjs file(s) have issues:`)
    for (const f of report.staleFeatureConfigs) {
      lines.push(`   - ${f.path}`)
      for (const issue of f.issues) {
        lines.push(`       · ${issue}`)
      }
    }
  } else {
    lines.push('✓ All feature.config.cjs files look clean.')
  }
  lines.push('')

  // Heal prompt
  if (report.healPromptStatus === 'matches-current') {
    lines.push('✓ Heal prompt in CLAUDE.md is up to date.')
  } else if (report.healPromptStatus === 'matches-old-exact') {
    lines.push('⚠  Heal prompt in CLAUDE.md matches a known prior version. Diff:')
    if (report.healPromptDiff) {
      for (const ln of report.healPromptDiff.split('\n')) lines.push(`   ${ln}`)
    }
  } else {
    lines.push('⚠  Heal prompt in CLAUDE.md is customized or missing.')
    if (report.healPromptNote) lines.push(`   ${report.healPromptNote}`)
    if (report.healPromptDiff) {
      lines.push('   Compare against the current template:')
      for (const ln of report.healPromptDiff.split('\n')) lines.push(`   ${ln}`)
    }
  }
  lines.push('')

  // CI hints
  if (report.ciPathHints.length > 0) {
    lines.push('⚠  CI / scripts reference old log paths (will read stale data on 0.10.x):')
    for (const h of report.ciPathHints) {
      lines.push(`   ${h.file}:${h.line}: ${h.content.trim()}`)
    }
    lines.push('   Update to logs/current/heal-index.md and logs/current/svc-*.log respectively.')
  } else {
    lines.push('✓ No CI scripts referencing old log paths.')
  }

  return lines.join('\n')
}

/** True iff there is anything for the user to act on. Used by --check exit code. */
export function hasPendingMigrations(report: MigrationReport): boolean {
  return (
    report.orphanedLogs.length > 0 ||
    report.staleFeatureConfigs.length > 0 ||
    report.healPromptStatus !== 'matches-current' ||
    report.ciPathHints.length > 0
  )
}
