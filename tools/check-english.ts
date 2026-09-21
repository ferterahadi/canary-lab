import fs from 'node:fs'
import path from 'node:path'
import { isCanaryLabWorkspace, looksLikeProjectRoot } from '../shared/runtime/project-root'
import { readWorkspaceRegistry } from '../shared/runtime/workspace-registry'
import { runAsScript } from '../apps/cli/run-as-script'
import { auditEnglishSource, type EnglishSourceAudit } from './english-audit'
import { READABLE_TEST_VERSION } from '../shared/readable-tests/types'

const SOURCE = /\.[cm]?[jt]sx?$/
const EXCLUDED = new Set(['.git', 'node_modules', 'envsets', '.runtime', 'logs', 'test-results', 'playwright-report', 'coverage'])
const USAGE = 'npm run check:english -- [--workspace <path>] [--json]'

function validWorkspace(root: string): boolean {
  return isCanaryLabWorkspace(root) && looksLikeProjectRoot(root)
}

export function resolveEnglishWorkspace(options: { workspace?: string; cwd?: string; env?: NodeJS.ProcessEnv; registry?: ReturnType<typeof readWorkspaceRegistry> } = {}): string {
  const explicit = options.workspace ?? (options.env ?? process.env).CANARY_LAB_PROJECT_ROOT
  if (explicit) {
    const resolved = path.resolve(explicit)
    if (!validWorkspace(resolved)) throw new Error(`Not a Canary Lab workspace: ${resolved}`)
    return fs.realpathSync(resolved)
  }
  let current = path.resolve(options.cwd ?? process.cwd())
  for (;;) {
    if (validWorkspace(current)) return fs.realpathSync(current)
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  const workspaces = [...new Set((options.registry ?? readWorkspaceRegistry()).workspaces
    .filter((entry) => validWorkspace(entry.path)).map((entry) => fs.realpathSync(entry.path)))].sort()
  if (workspaces.length === 1) return workspaces[0]
  if (workspaces.length === 0) throw new Error('No Canary Lab workspace found. Supply --workspace <path>.')
  throw new Error(`Multiple Canary Lab workspaces found. Supply --workspace <path>:\n${workspaces.join('\n')}`)
}

export function auditEnglishWorkspace(workspace: string): EnglishSourceAudit[] {
  const files: string[] = []
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (EXCLUDED.has(entry.name)) continue
      const file = path.join(directory, entry.name)
      if (entry.isSymbolicLink()) throw new Error(`Cannot audit linked suite input without an explicit source boundary: ${file}`)
      if (entry.isDirectory()) visit(file)
      else if (entry.isFile() && SOURCE.test(entry.name)) files.push(file)
    }
  }
  visit(path.join(workspace, 'features'))
  if (!files.length) throw new Error(`No JavaScript or TypeScript suite inputs found in ${workspace}`)
  return files.map((file) => auditEnglishSource(path.relative(workspace, file), fs.readFileSync(file, 'utf8')))
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  let workspace: string | undefined
  let json = false
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--help') { console.log(USAGE); return }
    if (args[index] === '--json') json = true
    else if (args[index] === '--workspace' && args[index + 1] && !args[index + 1].startsWith('--')) workspace = args[++index]
    else throw new Error(`Unknown or incomplete argument: ${args[index]}. ${USAGE}`)
  }
  const root = resolveEnglishWorkspace({ workspace })
  const files = auditEnglishWorkspace(root)
  const issues = files.flatMap((file) => file.issues)
  const summary = { workspace: root, scope: 'current feature source', translatorVersion: READABLE_TEST_VERSION, files: files.length, tests: files.reduce((sum, file) => sum + file.tests, 0),
    required: files.reduce((sum, file) => sum + file.required, 0), represented: files.reduce((sum, file) => sum + file.represented, 0), gaps: issues.length }
  if (json) console.log(JSON.stringify({ ...summary, results: files }, null, 2))
  else {
    console.log(`Workspace: ${root}`)
    console.log(`${summary.files} source files; ${summary.tests} test declarations; ${summary.represented}/${summary.required} source constructs represented; ${summary.gaps} gaps.`)
    const groups = new Map<string, typeof issues>()
    for (const issue of issues) {
      const key = `${issue.reason}: ${issue.syntaxKind}`
      groups.set(key, [...(groups.get(key) ?? []), issue])
    }
    for (const [key, group] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
      console.log(`\n${key} (${group.length})`)
      for (const issue of group) console.log(`  ${issue.file}:${issue.line}:${issue.column} [${issue.surface}] ${issue.message}`)
    }
  }
  process.exitCode = issues.length ? 1 : 0
}

runAsScript(module, main)
