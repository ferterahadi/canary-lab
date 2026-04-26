import fs from 'fs'
import path from 'path'
import { execFileSync } from 'child_process'
import { ok, section, step, line, path as ansiPath } from '../shared/cli-ui/ui'
import { fail } from '../shared/cli-ui/ui'
import { runAsScript } from './run-as-script'

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

export function parseArgs(args: string[]): { folder: string; packageSpec: string } {
  const folder = args[0]
  if (!folder) {
    fail('Usage: canary-lab init <folder> [--package-spec <spec>]')
    process.exit(1)
  }

  let packageSpec = `^${readPackageVersion()}`

  for (let i = 1; i < args.length; i += 1) {
    if (args[i] === '--package-spec') {
      packageSpec = args[i + 1]
      i += 1
    }
  }

  if (!packageSpec) {
    fail('Missing value for --package-spec')
    process.exit(1)
  }

  return { folder, packageSpec }
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
        'canary-lab:run': 'canary-lab run',
        'canary-lab:env': 'canary-lab env',
        'canary-lab:new-feature': 'canary-lab new-feature',
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

export async function main(args = process.argv.slice(2)): Promise<void> {
  const { folder, packageSpec } = parseArgs(args)
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

  // Initialize a git repo so agent tools (e.g. claude --dangerously-skip-permissions)
  // that require a trusted/git-backed workspace can run unattended.
  if (!fs.existsSync(path.join(targetDir, '.git'))) {
    try {
      execFileSync('git', ['init', '-q'], { cwd: targetDir, stdio: 'ignore' })
    } catch {
      /* git not installed or init failed — non-fatal */
    }
  }

  ok(`Canary Lab project created at ${ansiPath(targetDir)}`)
  section('Next steps')
  step(1, `cd ${folder}`)
  step(2, 'npm install')
  step(3, 'npm run install:browsers')
  step(4, 'npx canary-lab run')
  line()
}

runAsScript(module, main)
