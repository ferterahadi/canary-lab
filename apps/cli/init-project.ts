import fs from 'fs'
import path from 'path'
import { execFileSync } from 'child_process'
import { ok, section, step, line, path as ansiPath } from '../../shared/cli-ui/ui'
import { fail } from '../../shared/cli-ui/ui'
import { copyDirRecursive } from '../../shared/lib/copy-dir'
import { runAsScript } from './run-as-script'
import { SCAFFOLD_SCRIPTS } from './scaffold-scripts'
import { setup as setupCanaryLab } from './setup'
import { isValidPort } from '../web-server/src/features/runs/logic/runtime/launcher/project-config'
import { pickAvailableHealAgent } from '../web-server/src/features/runs/logic/runtime/heal-agent-spawn'

/** The repair agent this machine can actually spawn — `claude`, then `codex`,
 *  else nothing. Never throws: a probe failure is the same answer as "no CLI
 *  here", and scaffolding must not die over it. */
export function resolveLocalHealAgent(): 'claude' | 'codex' | null {
  try {
    return pickAvailableHealAgent()
  } catch {
    return null
  }
}

export function resolveFirstExisting(pathsToTry: string[]): string {
  const match = pathsToTry.find((candidate) => fs.existsSync(candidate))
  if (!match) {
    throw new Error(`Could not resolve any expected path: ${pathsToTry.join(', ')}`)
  }
  return match
}

function getPackageJsonPath(): string {
  // apps/cli/ → repo root in source; dist/apps/cli/ → the installed package root
  // (node_modules/canary-lab/) once compiled, which is one level further.
  return resolveFirstExisting([
    path.resolve(__dirname, '../../package.json'),
    path.resolve(__dirname, '../../../package.json'),
  ])
}

function getTemplateRoot(): string {
  return resolveFirstExisting([
    path.resolve(__dirname, '../../templates/project'),
    path.resolve(__dirname, '../../../templates/project'),
  ])
}

/** The shipped storefront suite's recorded history, seeded into the new
 *  workspace's `logs/`: one dry-run boot, and one saved port-ification.
 *
 *  Both stages report on an EVENT rather than a file, so on a brand-new scaffold
 *  they had nothing to read — Suite setup showed empty "Services booted" and
 *  "Boot time" tiles, and Parallel readiness showed the config's declaration
 *  with no side-by-side proof and no port changes under it. Seeding the records
 *  fills them, and — because it happens here — `npm run demo` and a user's own
 *  `npx canary-lab init` land in exactly the same state, which is what makes the
 *  demo testable.
 *
 *  It lives OUTSIDE `templates/project/` on purpose. The build skips
 *  `project/logs` (the smoke tests boot against the template tree and leave
 *  runtime records there), so a fixture kept inside it would be dropped from the
 *  tarball — or overwritten by a test run. */
function getBootRecordRoot(): string | null {
  const candidates = [
    path.resolve(__dirname, '../../templates/demo-boot'),
    path.resolve(__dirname, '../../../templates/demo-boot'),
  ]
  return candidates.find((c) => fs.existsSync(c)) ?? null
}

/** Re-home the seeded portify record's paths onto this workspace.
 *
 *  The record names the feature directory and each service's repo, and both are
 *  absolute at runtime — a machine-specific path nobody can ship. The template
 *  stores them workspace-relative and this resolves them once, at the only
 *  moment the target directory is known. A record left relative would point the
 *  Ports tab and the config drill-through at directories that don't exist. */
export function seedDemoRecordPaths(targetDir: string): void {
  const portifyRoot = path.join(targetDir, 'logs', 'portify')
  let ids: string[]
  try {
    ids = fs.readdirSync(portifyRoot)
  } catch {
    return
  }
  const absolute = (p: unknown): unknown =>
    typeof p === 'string' && !path.isAbsolute(p) ? path.join(targetDir, p) : p
  for (const id of ids) {
    const file = path.join(portifyRoot, id, 'portify.json')
    let record: { featureDir?: unknown; repos?: unknown }
    try {
      record = JSON.parse(fs.readFileSync(file, 'utf-8'))
    } catch {
      continue
    }
    record.featureDir = absolute(record.featureDir)
    if (Array.isArray(record.repos)) {
      record.repos = record.repos.map((repo) =>
        repo && typeof repo === 'object'
          ? { ...(repo as Record<string, unknown>), path: absolute((repo as { path?: unknown }).path) }
          : repo,
      )
    }
    fs.writeFileSync(file, JSON.stringify(record, null, 2) + '\n')
  }
}

// npm pack strips `.gitignore` from published tarballs (a long-standing npm
// behavior to prevent accidentally shipping ignore rules). The template
// stores it as `gitignore` (no dot) and we restore the leading dot on copy.
const TEMPLATE_RENAMES: Record<string, string> = {
  gitignore: '.gitignore',
}

/** Commit everything the scaffold wrote. Portify runs each repo in a throwaway git
 *  worktree, and a worktree only sees COMMITTED files — so a scaffold left uncommitted
 *  fails every portify with a 409 ("repo has uncommitted changes"), a stage failure the
 *  user has no way to act on. Must run AFTER `npm install`: the install writes
 *  package-lock.json, which is tracked, so committing earlier leaves the tree dirty and
 *  the 409 returns.
 *
 *  Unconditional by design. `main` refuses a non-empty target, so the repo here is
 *  always one this command just created — there is no user history to protect. When git
 *  is absent (or `git init` failed) `add` throws that this is not a repository and the
 *  swallow below is the whole handling.
 *
 *  Identity and signing are pinned per-invocation rather than read from global config so
 *  an unattended init cannot block on an absent `user.email` or a GPG passphrase prompt. */
export function commitScaffold(targetDir: string): void {
  try {
    execFileSync('git', ['add', '-A'], { cwd: targetDir, stdio: 'ignore' })
    execFileSync('git', [
      '-c', 'user.name=Canary Lab',
      '-c', 'user.email=canary-lab@localhost',
      '-c', 'commit.gpgsign=false',
      'commit', '-q', '-m', 'chore: scaffold Canary Lab workspace',
    ], { cwd: targetDir, stdio: 'ignore' })
  } catch {
    /* Not a repo, nothing to commit, or a hook refused — the scaffold is still
       usable, and portify reports the uncommitted-changes 409 if it mattered.
       Not worth failing an otherwise-complete init over. */
  }
}

/** The sample product repos the scaffold lays down beside `features/`. */
const SAMPLE_REPO_DIRS = ['demo-app', 'flight-app', 'workflow-app'] as const

/** Make each shipped sample app its own committed git repository — that is what
 *  Canary Lab points at: a repo, not a subdirectory of the workspace. The demo
 *  harness (tools/smoke-demo.mjs) always did this after `init`, so the demo's
 *  flights and portify runs cut their worktrees from the small sample repo while
 *  a real user's were cut from the whole workspace repo — the one divergence
 *  between `demo` and `init` that must not exist.
 *
 *  Runs AFTER commitScaffold on purpose: if nesting a sample's .git fails, the
 *  workspace commit still tracks its files, so every git surface keeps working
 *  against the workspace repo (worktrees cut at the git toplevel). Each sample
 *  that DOES nest is then handed off — untracked and ignored in the workspace
 *  repo — because leaving it tracked by both meant every heal edit inside a
 *  sample showed up as phantom workspace dirt. Same swallow-per-repo rationale
 *  as commitScaffold. */
export function commitSampleRepos(targetDir: string): void {
  const nested: string[] = []
  for (const dir of SAMPLE_REPO_DIRS) {
    const repoDir = path.join(targetDir, dir)
    if (!fs.existsSync(repoDir)) continue
    try {
      if (!fs.existsSync(path.join(repoDir, '.git'))) {
        execFileSync('git', ['init', '-q'], { cwd: repoDir, stdio: 'ignore' })
      }
      execFileSync('git', ['add', '-A'], { cwd: repoDir, stdio: 'ignore' })
      execFileSync('git', [
        '-c', 'user.name=Canary Lab',
        '-c', 'user.email=canary-lab@localhost',
        '-c', 'commit.gpgsign=false',
        'commit', '-q', '-m', `chore: ${dir} sample baseline`,
      ], { cwd: repoDir, stdio: 'ignore' })
      nested.push(dir)
    } catch {
      /* Same trade as commitScaffold: an uncommitted sample still runs; the
         dirty-repo preflights name the problem if it ever matters. */
    }
  }
  if (nested.length === 0) return
  // Hand the nested samples off: drop them from the workspace index and ignore
  // them, so a sample edit dirties only its own repo. `--cached` keeps the
  // files; the gitignore append is guarded so a re-run never stacks duplicate
  // lines. Each step swallows on its own so a mid-list failure still reaches
  // the commit — staged-but-uncommitted hand-offs would leave the workspace
  // tree dirty, the exact state commitScaffold exists to prevent.
  try {
    const gitignore = path.join(targetDir, '.gitignore')
    const existing = fs.existsSync(gitignore) ? fs.readFileSync(gitignore, 'utf-8') : ''
    const lines = nested.map((dir) => `/${dir}/`).filter((line) => !existing.split('\n').includes(line))
    if (lines.length > 0) {
      fs.writeFileSync(gitignore, `${existing.replace(/\n*$/, '\n')}${lines.join('\n')}\n`)
    }
  } catch {
    /* Unwritable .gitignore — the rm --cached below still stops the tracking. */
  }
  for (const dir of nested) {
    try {
      execFileSync('git', ['rm', '-r', '-q', '--cached', dir], { cwd: targetDir, stdio: 'ignore' })
    } catch {
      /* No workspace repo, or this sample was never tracked (already handed
         off on a previous run) — nothing to untrack. */
    }
  }
  try {
    execFileSync('git', ['add', '.gitignore'], { cwd: targetDir, stdio: 'ignore' })
    execFileSync('git', [
      '-c', 'user.name=Canary Lab',
      '-c', 'user.email=canary-lab@localhost',
      '-c', 'commit.gpgsign=false',
      'commit', '-q', '-m', 'chore: hand sample apps to their own repositories',
    ], { cwd: targetDir, stdio: 'ignore' })
  } catch {
    /* No workspace repo, or nothing was staged (re-run) — the double-tracking
       this cleans up is cosmetic, never blocking. */
  }
}

export function copyDir(sourceDir: string, targetDir: string): void {
  copyDirRecursive(sourceDir, targetDir, (name) => TEMPLATE_RENAMES[name] ?? name)
}

function readPackageVersion(): string {
  const pkgPath = getPackageJsonPath()
  return JSON.parse(fs.readFileSync(pkgPath, 'utf-8')).version
}

export function parseArgs(args: string[]): { folder: string; packageSpec: string; port?: number; noInstall: boolean } {
  const folder = args[0]
  if (!folder) {
    fail('Usage: canary-lab init <folder> [--package-spec <spec>] [--port <port>] [--no-install]')
    process.exit(1)
  }

  let packageSpec = `^${readPackageVersion()}`
  let port: number | undefined
  let noInstall = false

  for (let i = 1; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === '--no-install') {
      noInstall = true
      continue
    }
    if (arg === '--package-spec') {
      packageSpec = args[i + 1]
      i += 1
      continue
    }
    if (arg === '--port' || arg.startsWith('--port=')) {
      const raw = arg.startsWith('--port=') ? arg.slice('--port='.length) : args[++i]
      const parsed = Number(raw)
      if (!isValidPort(parsed)) {
        fail(`Invalid --port value: ${raw ?? ''} (expected an integer between 1 and 65535)`)
        process.exit(1)
      }
      port = parsed
      continue
    }
  }

  if (!packageSpec) {
    fail('Missing value for --package-spec')
    process.exit(1)
  }

  return { folder, packageSpec, noInstall, ...(port === undefined ? {} : { port }) }
}

export function buildPackageJson(projectName: string, packageSpec: string): string {
  return JSON.stringify(
    {
      name: projectName,
      private: true,
      version: '0.1.0',
      description: 'Canary Lab project scaffold',
      scripts: SCAFFOLD_SCRIPTS,
      devDependencies: {
        '@playwright/test': '^1.54.2',
        '@types/node': '^22.0.0',
        'canary-lab': packageSpec,
        dotenv: '^16.6.1',
        tsx: '^4.20.3',
      },
    },
    null,
    2,
  ) + '\n'
}

export interface InitProjectExtras {
  setupProject?: typeof setupCanaryLab
}

// Resolve the installed package's own CLI entry by READING its `bin` field, rather
// than re-spelling the built path here. The re-spelled version said
// `dist/scripts/cli.js` while the build emits `dist/apps/cli/cli.js`, so the
// existence check was never satisfiable: the "stable local cli.js" branch in main()
// was dead and every `init` fell back to the running process's path — the
// GC-eligible `_npx` cache that branch exists to avoid, or a throwaway temp install
// that then owned the user's global MCP pointer. Reading `bin` cannot drift from
// where the file actually is.
//
// Returns null when the package, its `bin`, or the target file is missing — the
// caller treats that the same as "not installed" and leaves registration to its
// own fallback.
function installedCliPath(pkgRoot: string): string | null {
  let bin: unknown
  try {
    bin = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf-8')).bin
  } catch {
    // Best-effort: a missing or unreadable package.json means the install did not
    // land, which the caller already handles.
    return null
  }
  const rel = typeof bin === 'string' ? bin : (bin as Record<string, unknown> | null)?.['canary-lab']
  if (typeof rel !== 'string' || rel === '') return null
  const abs = path.join(pkgRoot, rel)
  return fs.existsSync(abs) ? abs : null
}

export async function main(
  args = process.argv.slice(2),
  extras: InitProjectExtras = {},
): Promise<void> {
  const { folder, packageSpec, port, noInstall } = parseArgs(args)
  const targetDir = path.resolve(process.cwd(), folder)

  if (fs.existsSync(targetDir)) {
    const entries = fs.readdirSync(targetDir)
    if (entries.length > 0) {
      fail(`Target directory is not empty: ${targetDir}`)
      process.exit(1)
    }
  } else {
    fs.mkdirSync(targetDir, { recursive: true })
  }

  copyDir(getTemplateRoot(), targetDir)

  const bootRecord = getBootRecordRoot()
  if (bootRecord) {
    copyDir(bootRecord, path.join(targetDir, 'logs'))
    seedDemoRecordPaths(targetDir)
  }

  let projectName = path.basename(targetDir)
  if (projectName === 'canary-lab') {
    projectName = 'canary-lab-workspace'
  }
  fs.writeFileSync(
    path.join(targetDir, 'package.json'),
    buildPackageJson(projectName, packageSpec),
  )

  // Pin the chosen port so `canary-lab ui` and the MCP bridge use it, and pin
  // the repair agent to whichever CLI this machine actually has.
  //
  // `healAgent` defaults to `external` — "wait for a Claude/Codex client to
  // claim the run over MCP" — which is right for an MCP-driven workspace and
  // wrong for the very first thing a new user does. The scaffold's own tour says
  // "Press Run to watch a repair"; with no agent configured that run reaches
  // HEALING and waits forever for a client nobody told them to connect. Only
  // `npm run demo` worked, because its harness writes this same key before
  // booting — which is exactly the divergence between `demo` and `init` that
  // must not exist.
  //
  // Resolved rather than hardcoded, so Settings shows the agent that is really
  // going to run. No CLI installed → left unset, and the default stands.
  const healAgent = resolveLocalHealAgent()
  if (port !== undefined || healAgent) {
    fs.writeFileSync(
      path.join(targetDir, 'canary-lab.config.json'),
      JSON.stringify({
        ...(port === undefined ? {} : { port }),
        ...(healAgent ? { healAgent } : {}),
      }, null, 2) + '\n',
    )
  }

  // Initialize a git repo so agent tools (e.g. claude --dangerously-skip-permissions)
  // that require a trusted/git-backed workspace can run unattended.
  if (!fs.existsSync(path.join(targetDir, '.git'))) {
    try {
      execFileSync('git', ['init', '-q'], { cwd: targetDir, stdio: 'ignore' })
    } catch {
      /* git not installed or init failed — non-fatal */
    }
  }

  // One install. The scaffold's postinstall syncs the workspace and downloads
  // the Playwright browser, so there is no second command to forget.
  // `--no-install` skips this (CI / offline); the manual command is printed in
  // "Next steps" when skipped or on failure.
  let installed = false
  if (!noInstall) {
    try {
      section('Installing dependencies')
      execFileSync('npm', ['install'], { cwd: targetDir, stdio: 'inherit' })
      installed = true
    } catch (err) {
      console.log(`Dependency install skipped: ${(err as Error).message}`)
    }
  }

  // Register MCP. After a successful install, point registration at the STABLE
  // local cli.js under node_modules rather than this process's path — which, when
  // `init` was run via `npx`, is the GC-eligible `_npx` cache. A stable absolute
  // path also lets GUI (Desktop) registration embed a working node-dir PATH, so
  // a Desktop-launched server can still spawn the agent CLIs.
  const localCli = installedCliPath(path.join(targetDir, 'node_modules', 'canary-lab'))
  const setupOpts = installed && localCli
    ? { cliPath: localCli, execPath: process.execPath }
    : {}
  const setupProject = extras.setupProject ?? setupCanaryLab
  let setupOk = true
  try {
    setupProject(
      // implicit: an init-driven setup in a temp workspace (smoke test or a
      // user-created disposable workspace)
      // must not claim the user's global MCP pointers — see setup.ts.
      { workspace: targetDir, agent: 'auto', dryRun: false, force: false, implicit: true },
      setupOpts,
    )
  } catch (err) {
    setupOk = false
    console.log(`Canary Lab setup skipped: ${(err as Error).message}`)
  }

  commitScaffold(targetDir)
  commitSampleRepos(targetDir)

  ok(`Canary Lab project created at ${ansiPath(targetDir)}`)
  section('Next steps')
  let stepNum = 1
  step(stepNum++, `cd ${folder}`)
  if (!installed) {
    step(stepNum++, 'npm install')
  }
  step(stepNum++, 'npx canary-lab ui')
  if (!setupOk) {
    step(stepNum++, 'npx canary-lab setup')
  }
  line()
}

runAsScript(module, main)
