import {
  applyFeatureScaffold,
  buildFeatureScaffold,
  canonicalScaffoldPaths,
  isValidFeatureName,
} from '../shared/feature-scaffold'
import { getProjectRoot } from '../shared/runtime/project-root'
import { bullet, dim, fail, ok, path as ansiPath, section, step, line } from '../shared/cli-ui/ui'
import { runAsScript } from './run-as-script'

interface ParsedArgs {
  name?: string
  description?: string
}

export function parseArgs(args: string[]): ParsedArgs {
  const out: ParsedArgs = {}
  const descriptionParts: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--description') {
      out.description = args[++i] ?? ''
    } else if (!out.name) {
      out.name = arg
    } else if (out.description === undefined) {
      descriptionParts.push(arg)
    }
  }
  if (out.description === undefined && descriptionParts.length > 0) {
    out.description = descriptionParts.join(' ')
  }
  return out
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const parsed = parseArgs(args)
  const name = parsed.name

  if (!name) {
    fail('Usage: canary-lab new feature <name> [--description "..."]')
    process.exit(1)
  }

  if (!isValidFeatureName(name)) {
    fail(`Invalid feature name "${name}". Use letters, numbers, hyphens, or underscores.`)
    process.exit(1)
  }

  const projectRoot = getProjectRoot()
  const files = buildFeatureScaffold({ featureName: name, description: parsed.description })
  const result = applyFeatureScaffold({ projectRoot, featureName: name, files })

  if (!result.ok) {
    fail(result.details ?? `Could not create feature: ${result.error}`)
    process.exit(result.error === 'feature-exists' ? 2 : 1)
  }

  ok(`Feature "${name}" created at ${ansiPath(`features/${name}/`)}`)
  section('Created files')
  for (const relPath of canonicalScaffoldPaths(name)) {
    bullet(dim(`features/${name}/`) + relPath)
  }
  section('Next steps')
  step(1, `Edit ${ansiPath(`features/${name}/feature.config.cjs`)} with repos, start commands, and health checks`)
  step(2, `Edit ${ansiPath(`features/${name}/envsets/local/${name}.env`)} with local env values`)
  step(3, `Replace the example test in ${ansiPath(`features/${name}/e2e/${name}.spec.ts`)}`)
  step(4, 'Run: npx canary-lab ui')
  line()
}

runAsScript(module, () => main())
