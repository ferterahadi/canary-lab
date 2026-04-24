import fs from 'fs'
import path from 'path'
import { getProjectRoot, getFeaturesDir } from '../shared/runtime/project-root'
import { ok, warn, info, bullet, fail, section, line, dim, path as ansiPath } from '../shared/cli-ui/ui'

const LEGACY_PLAYWRIGHT_CONFIG = `import { defineConfig } from '@playwright/test'
import { baseConfig } from 'canary-lab/feature-support/playwright-base'

export default defineConfig({ ...baseConfig })
`

const NEW_PLAYWRIGHT_CONFIG = `import path from 'node:path'
import { config as loadDotenv } from 'dotenv'
import { defineConfig } from '@playwright/test'
import { baseConfig } from 'canary-lab/feature-support/playwright-base'

loadDotenv({ path: path.join(__dirname, '.env') })

export default defineConfig({ ...baseConfig })
`

/**
 * Matches the exact 0.8.0 `src/config.ts` shape, capturing the GATEWAY_URL default.
 * Any deviation (extra imports, extra exports, renamed constant, whitespace changes
 * beyond the canonical form) makes the regex fail, and migrate skips the feature.
 */
const LEGACY_CONFIG_RE =
  /^import path from 'node:path'\nimport \{ config as loadDotenv \} from 'dotenv'\n\nloadDotenv\(\{ path: path\.join\(__dirname, '\.\.', '\.env'\) \}\)\n\nexport const GATEWAY_URL = process\.env\.GATEWAY_URL \?\? '([^']+)'\n?$/

export interface MigrateOptions {
  dryRun: boolean
}

export interface FeatureOutcome {
  name: string
  migrated: boolean
  reason?: string
}

function parseArgs(args: string[]): MigrateOptions {
  return { dryRun: args.includes('--dry-run') }
}

function listFeatures(featuresDir: string): string[] {
  if (!fs.existsSync(featuresDir)) return []
  return fs
    .readdirSync(featuresDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
}

function isLegacyFeature(featureDir: string): boolean {
  return fs.existsSync(path.join(featureDir, 'src', 'config.ts'))
}

interface PlannedWrite {
  filePath: string
  content: string
}

interface PlannedDelete {
  filePath: string
  isDir: boolean
}

interface FeaturePlan {
  writes: PlannedWrite[]
  deletes: PlannedDelete[]
}

/**
 * Returns a plan for how to convert one legacy feature to the new layout, or a
 * skip reason if any file diverges from the 0.8.0 canonical shape.
 */
export function planFeatureMigration(
  featureDir: string,
): { ok: true; plan: FeaturePlan } | { ok: false; reason: string } {
  const configPath = path.join(featureDir, 'src', 'config.ts')
  const configSrc = fs.readFileSync(configPath, 'utf-8')
  const configMatch = configSrc.match(LEGACY_CONFIG_RE)
  if (!configMatch) {
    return { ok: false, reason: 'src/config.ts has been modified from the 0.8.0 shape' }
  }
  const defaultUrl = configMatch[1]

  const playwrightPath = path.join(featureDir, 'playwright.config.ts')
  if (!fs.existsSync(playwrightPath)) {
    return { ok: false, reason: 'playwright.config.ts is missing' }
  }
  const playwrightSrc = fs.readFileSync(playwrightPath, 'utf-8')
  if (playwrightSrc !== LEGACY_PLAYWRIGHT_CONFIG) {
    return { ok: false, reason: 'playwright.config.ts has been modified from the 0.8.0 shape' }
  }

  const helpersDir = path.join(featureDir, 'e2e', 'helpers')
  const helperWrites: PlannedWrite[] = []
  if (fs.existsSync(helpersDir)) {
    for (const entry of fs.readdirSync(helpersDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.ts')) continue
      const filePath = path.join(helpersDir, entry.name)
      const src = fs.readFileSync(filePath, 'utf-8')
      if (!src.includes("from '../../src/config'")) continue

      const rewritten = rewriteHelper(src, defaultUrl)
      if (rewritten.ok === false) {
        return { ok: false, reason: `e2e/helpers/${entry.name}: ${rewritten.reason}` }
      }
      helperWrites.push({ filePath, content: rewritten.content })
    }
  }

  return {
    ok: true,
    plan: {
      writes: [
        { filePath: playwrightPath, content: NEW_PLAYWRIGHT_CONFIG },
        ...helperWrites,
      ],
      deletes: [
        { filePath: configPath, isDir: false },
        { filePath: path.join(featureDir, 'src'), isDir: true },
      ],
    },
  }
}

/**
 * Rewrites a single helper file: drops the `from '../../src/config'` import line
 * and replaces bare `GATEWAY_URL` usages with the inline env-read expression.
 *
 * Only accepts the canonical case where exactly `{ GATEWAY_URL }` is imported;
 * any additional identifier or a different shape returns a skip reason.
 */
export function rewriteHelper(
  src: string,
  defaultUrl: string,
): { ok: true; content: string } | { ok: false; reason: string } {
  const importRe = /^import \{ ([^}]+) \} from '\.\.\/\.\.\/src\/config'\r?\n/m
  const match = src.match(importRe)
  if (!match) {
    return { ok: false, reason: "import from '../../src/config' uses an unexpected form" }
  }
  const named = match[1]
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  if (named.length !== 1 || named[0] !== 'GATEWAY_URL') {
    return {
      ok: false,
      reason: `expected \`import { GATEWAY_URL }\` but got \`import { ${match[1]} }\``,
    }
  }

  // Drop the import line plus one trailing blank line if present.
  let out = src.replace(importRe, '')
  out = out.replace(/^\n/, '')

  const replacement = `process.env.GATEWAY_URL ?? '${defaultUrl}'`
  const usageRe = /\bGATEWAY_URL\b/g
  out = out.replace(usageRe, replacement)

  return { ok: true, content: out }
}

function applyPlan(plan: FeaturePlan): void {
  for (const w of plan.writes) {
    fs.writeFileSync(w.filePath, w.content)
  }
  for (const d of plan.deletes) {
    if (d.isDir) {
      // Only remove if empty — respects user files we didn't plan for.
      try {
        fs.rmdirSync(d.filePath)
      } catch {
        /* not empty or missing — ignore */
      }
    } else {
      try {
        fs.unlinkSync(d.filePath)
      } catch {
        /* already gone — ignore */
      }
    }
  }
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const opts = parseArgs(args)

  let projectRoot: string
  try {
    projectRoot = getProjectRoot()
  } catch {
    fail('Could not find Canary Lab project root (no features/ directory found).')
    process.exit(1)
  }

  if (!fs.existsSync(path.join(projectRoot, 'features'))) {
    fail('Not a Canary Lab project (no features/ directory). Run `canary-lab init` first.')
    process.exit(1)
  }

  const featuresDir = getFeaturesDir()
  const allFeatures = listFeatures(featuresDir)
  const legacyFeatures = allFeatures.filter((name) =>
    isLegacyFeature(path.join(featuresDir, name)),
  )

  if (legacyFeatures.length === 0) {
    ok('Nothing to migrate — no features with the 0.8.0 `src/config.ts` layout detected.')
    return
  }

  section(opts.dryRun ? 'Migrate (dry run)' : 'Migrate')
  if (opts.dryRun) {
    info('Dry-run mode — no files will be changed.')
  }

  const outcomes: FeatureOutcome[] = []
  for (const name of legacyFeatures) {
    const featureDir = path.join(featuresDir, name)
    const result = planFeatureMigration(featureDir)
    if (result.ok === false) {
      warn(`Skipped ${ansiPath(`features/${name}`)} — ${result.reason}`)
      outcomes.push({ name, migrated: false, reason: result.reason })
      continue
    }
    if (!opts.dryRun) {
      applyPlan(result.plan)
    }
    ok(`${opts.dryRun ? 'Would migrate' : 'Migrated'} ${ansiPath(`features/${name}`)}`)
    for (const w of result.plan.writes) {
      bullet(dim(`write ${path.relative(projectRoot, w.filePath)}`))
    }
    for (const d of result.plan.deletes) {
      bullet(dim(`${d.isDir ? 'rmdir' : 'delete'} ${path.relative(projectRoot, d.filePath)}`))
    }
    outcomes.push({ name, migrated: true })
  }

  const migrated = outcomes.filter((o) => o.migrated).length
  const skipped = outcomes.filter((o) => !o.migrated).length

  section('Summary')
  bullet(`${opts.dryRun ? 'Would migrate' : 'Migrated'}: ${migrated}`)
  bullet(`Skipped: ${skipped}`)

  if (!opts.dryRun && migrated > 0) {
    line()
    info('Run `npx canary-lab run` to verify the migrated features still pass.')
  }
  if (skipped > 0) {
    line()
    info('Skipped features were left untouched — migrate them by hand if desired.')
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
