import fs from 'fs'
import path from 'path'
import { execFileSync } from 'child_process'
import { ok, section, step, line, path as ansiPath } from '../shared/cli-ui/ui'
import { fail } from '../shared/cli-ui/ui'
import { runAsScript } from './run-as-script'
import { setup as setupCanaryLab } from './setup'
import { isValidPort } from '../apps/web-server/src/features/runs/logic/runtime/launcher/project-config'

export function resolveFirstExisting(pathsToTry: string[]): string {
  const match = pathsToTry.find((candidate) => fs.existsSync(candidate))
  if (!match) {
    throw new Error(`Could not resolve any expected path: ${pathsToTry.join(', ')}`)
  }
  return match
}

function getPackageJsonPath(): string {
  return resolveFirstExisting([
    path.resolve(__dirname, '../package.json'),
    path.resolve(__dirname, '../../package.json'),
  ])
}

function getTemplateRoot(): string {
  return resolveFirstExisting([
    path.resolve(__dirname, '../templates/project'),
    path.resolve(__dirname, '../../templates/project'),
  ])
}

// npm pack strips `.gitignore` from published tarballs (a long-standing npm
// behavior to prevent accidentally shipping ignore rules). The template
// stores it as `gitignore` (no dot) and we restore the leading dot on copy.
const TEMPLATE_RENAMES: Record<string, string> = {
  gitignore: '.gitignore',
}

export function copyDir(sourceDir: string, targetDir: string): void {
  fs.mkdirSync(targetDir, { recursive: true })

  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const sourcePath = path.join(sourceDir, entry.name)
    const targetName = TEMPLATE_RENAMES[entry.name] ?? entry.name
    const targetPath = path.join(targetDir, targetName)

    if (entry.isDirectory()) {
      copyDir(sourcePath, targetPath)
      continue
    }

    fs.copyFileSync(sourcePath, targetPath)
  }
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
      scripts: {
        postinstall: 'canary-lab upgrade --silent',
        upgrade: 'canary-lab upgrade',
        'install:browsers': 'playwright install chromium',
      },
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

  let projectName = path.basename(targetDir)
  if (projectName === 'canary-lab') {
    projectName = 'canary-lab-workspace'
  }
  fs.writeFileSync(
    path.join(targetDir, 'package.json'),
    buildPackageJson(projectName, packageSpec),
  )

  // Pin the chosen port so `canary-lab ui` and the MCP bridge use it.
  if (port !== undefined) {
    fs.writeFileSync(
      path.join(targetDir, 'canary-lab.config.json'),
      JSON.stringify({ port }, null, 2) + '\n',
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

  // Install deps + the Playwright browser so the workspace is ready to boot in
  // one step. `--no-install` skips this (CI / offline); the manual commands are
  // printed in "Next steps" when skipped or on failure.
  let installed = false
  if (!noInstall) {
    try {
      section('Installing dependencies')
      execFileSync('npm', ['install'], { cwd: targetDir, stdio: 'inherit' })
      execFileSync('npm', ['run', 'install:browsers'], { cwd: targetDir, stdio: 'inherit' })
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
  const localCli = path.join(targetDir, 'node_modules', 'canary-lab', 'dist', 'scripts', 'cli.js')
  const setupOpts = installed && fs.existsSync(localCli)
    ? { cliPath: localCli, execPath: process.execPath }
    : {}
  const setupProject = extras.setupProject ?? setupCanaryLab
  let setupOk = true
  try {
    setupProject(
      { workspace: targetDir, agent: 'auto', dryRun: false, force: false },
      setupOpts,
    )
  } catch (err) {
    setupOk = false
    console.log(`Canary Lab setup skipped: ${(err as Error).message}`)
  }

  ok(`Canary Lab project created at ${ansiPath(targetDir)}`)
  section('Next steps')
  let stepNum = 1
  step(stepNum++, `cd ${folder}`)
  if (!installed) {
    step(stepNum++, 'npm install')
    step(stepNum++, 'npm run install:browsers')
  }
  step(stepNum++, 'npx canary-lab ui')
  if (!setupOk) {
    step(stepNum++, 'npx canary-lab setup')
  }
  line()
}

runAsScript(module, main)
