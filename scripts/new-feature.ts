import fs from 'fs'
import path from 'path'
import { getFeaturesDir } from '../shared/runtime/project-root'

function buildFeatureConfig(name: string, description: string): string {
  return `const config = {
  name: '${name}',
  description: '${description}',
  envs: ['local'],
  repos: [
    // {
    //   name: 'your-repo',
    //   localPath: '/absolute/path/to/your-repo',
    //   cloneUrl: 'git@github.com:your-org/your-repo.git',
    //   startCommands: [
    //     {
    //       name: 'your-repo dev server',
    //       command: 'npm run dev',
    //       healthCheck: {
    //         url: 'http://localhost:3000/',
    //         timeoutMs: 2000,
    //       },
    //     },
    //   ],
    // },
  ],
  featureDir: __dirname,
}

module.exports = { config }
`
}

function buildPlaywrightConfig(): string {
  return `import { defineConfig } from '@playwright/test'
import { baseConfig } from 'canary-lab/feature-support/playwright-base'

export default defineConfig({ ...baseConfig })
`
}

function buildFeatureConfigTs(): string {
  return `import path from 'node:path'
import { config as loadDotenv } from 'dotenv'

loadDotenv({ path: path.join(__dirname, '..', '.env') })

export const GATEWAY_URL = process.env.GATEWAY_URL ?? 'http://localhost:3000'
`
}

function buildEnvsetsConfig(name: string): string {
  return JSON.stringify(
    {
      appRoots: {},
      slots: {
        [`${name}.env`]: {
          description: `Canary Lab ${name} feature .env`,
          target: `$CANARY_LAB_PROJECT_ROOT/features/${name}/.env`,
        },
      },
      feature: {
        slots: [`${name}.env`],
        testCommand: 'npx playwright test',
        testCwd: `$CANARY_LAB_PROJECT_ROOT/features/${name}`,
      },
    },
    null,
    2,
  ) + '\n'
}

function buildSpec(name: string): string {
  return `import { test, expect } from 'canary-lab/feature-support/log-marker-fixture'

test.describe('${name}', () => {
  test('example test', async () => {
    expect(true).toBe(true)
  })
})
`
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const name = args[0]
  const description = args.slice(1).join(' ') || 'TODO: add description'

  if (!name) {
    console.error('Usage: canary-lab new-feature <name> [description]')
    process.exit(1)
  }

  if (!/^[a-z][a-z0-9_]*$/.test(name)) {
    console.error(
      `Invalid feature name "${name}". Use snake_case (e.g. cns_webhooks).`,
    )
    process.exit(1)
  }

  const featureDir = path.join(getFeaturesDir(), name)
  if (fs.existsSync(featureDir)) {
    console.error(`Feature "${name}" already exists at ${featureDir}`)
    process.exit(1)
  }

  const files: Array<[string, string]> = [
    ['feature.config.cjs', buildFeatureConfig(name, description)],
    ['playwright.config.ts', buildPlaywrightConfig()],
    ['.env.example', 'GATEWAY_URL=http://localhost:3000\n'],
    ['src/config.ts', buildFeatureConfigTs()],
    ['envsets/envsets.config.json', buildEnvsetsConfig(name)],
    [`envsets/local/${name}.env`, 'GATEWAY_URL=http://localhost:3000\n'],
    [`e2e/${name}.spec.ts`, buildSpec(name)],
  ]

  for (const [relPath, content] of files) {
    const fullPath = path.join(featureDir, relPath)
    fs.mkdirSync(path.dirname(fullPath), { recursive: true })
    fs.writeFileSync(fullPath, content)
  }

  fs.mkdirSync(path.join(featureDir, 'e2e/helpers'), { recursive: true })

  console.log(`\n  Feature "${name}" created at features/${name}/\n`)
  console.log('  Created files:')
  for (const [relPath] of files) {
    console.log(`    features/${name}/${relPath}`)
  }
  console.log(`    features/${name}/e2e/helpers/`)
  console.log('')
  console.log('  Next steps:')
  console.log('    1. Edit feature.config.cjs — add your repos, start commands, and health checks')
  console.log('    2. Edit src/config.ts — add feature-specific env var exports')
  console.log(`    3. Write your tests in e2e/${name}.spec.ts`)
  console.log('    4. Run: npx canary-lab run')
  console.log('')
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
