import fs from 'fs'
import path from 'path'

function resolveFirstExisting(pathsToTry: string[]): string {
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

function copyDir(sourceDir: string, targetDir: string): void {
  fs.mkdirSync(targetDir, { recursive: true })

  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const sourcePath = path.join(sourceDir, entry.name)
    const targetPath = path.join(targetDir, entry.name)

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

function parseArgs(args: string[]): { folder: string; packageSpec: string } {
  const folder = args[0]
  if (!folder) {
    console.error('Usage: canary-lab init <folder> [--package-spec <spec>]')
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
    console.error('Missing value for --package-spec')
    process.exit(1)
  }

  return { folder, packageSpec }
}

function buildPackageJson(projectName: string, packageSpec: string): string {
  return JSON.stringify(
    {
      name: projectName,
      private: true,
      version: '0.1.0',
      description: 'Canary Lab project scaffold',
      scripts: {
        'canary-lab:run': 'canary-lab run',
        'canary-lab:env': 'canary-lab env',
        'canary-lab:new-feature': 'canary-lab new-feature',
        'install:browsers': 'playwright install chromium',
      },
      devDependencies: {
        '@playwright/test': '^1.54.2',
        'canary-lab': packageSpec,
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
      console.error(`Target directory is not empty: ${targetDir}`)
      process.exit(1)
    }
  } else {
    fs.mkdirSync(targetDir, { recursive: true })
  }

  copyDir(getTemplateRoot(), targetDir)

  const projectName = path.basename(targetDir)
  fs.writeFileSync(
    path.join(targetDir, 'package.json'),
    buildPackageJson(projectName, packageSpec),
  )

  console.log(`\n  Canary Lab project created at ${targetDir}\n`)
  console.log('  Next steps:')
  console.log(`    1. cd ${folder}`)
  console.log('    2. npm install')
  console.log('    3. npm run install:browsers')
  console.log('    4. npx canary-lab run')
  console.log('')
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
