import fs from 'fs'
import path from 'path'
import { getFeaturesDir } from '../shared/runtime/project-root'
import { ok, section, step, bullet, fail, line, path as ansiPath, dim } from '../shared/cli-ui/ui'

export function isValidFeatureName(name: string): boolean {
  return /^[a-z][a-z0-9_]*$/.test(name)
}

export function buildFeatureConfig(name: string, description: string): string {
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

export function buildPlaywrightConfig(): string {
  return `import path from 'node:path'
import { config as loadDotenv } from 'dotenv'
import { defineConfig } from '@playwright/test'
import { baseConfig } from 'canary-lab/feature-support/playwright-base'

loadDotenv({ path: path.join(__dirname, '.env') })

export default defineConfig({ ...baseConfig })
`
}

export function buildEnvsetsConfig(name: string): string {
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

export function buildSpec(name: string): string {
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
    fail('Usage: canary-lab new-feature <name> [description]')
    process.exit(1)
  }

  if (!isValidFeatureName(name)) {
    fail(`Invalid feature name "${name}". Use snake_case (e.g. cns_webhooks).`)
    process.exit(1)
  }

  const featureDir = path.join(getFeaturesDir(), name)
  if (fs.existsSync(featureDir)) {
    fail(`Feature "${name}" already exists at ${featureDir}`)
    process.exit(1)
  }

  const files: Array<[string, string]> = [
    ['feature.config.cjs', buildFeatureConfig(name, description)],
    ['playwright.config.ts', buildPlaywrightConfig()],
    ['envsets/envsets.config.json', buildEnvsetsConfig(name)],
    [`envsets/local/${name}.env`, 'GATEWAY_URL=http://localhost:3000\n'],
    [`e2e/${name}.spec.ts`, buildSpec(name)],
  ]

  for (const [relPath, content] of files) {
    const fullPath = path.join(featureDir, relPath)
    fs.mkdirSync(path.dirname(fullPath), { recursive: true })
    fs.writeFileSync(fullPath, content)
  }

  ok(`Feature "${name}" created at ${ansiPath(`features/${name}/`)}`)
  section('Created files')
  for (const [relPath] of files) {
    bullet(dim(`features/${name}/`) + relPath)
  }
  section('Next steps')
  step(1, `Edit ${ansiPath('feature.config.cjs')} — add your repos, start commands, and health checks`)
  step(2, `Edit ${ansiPath(`envsets/local/${name}.env`)} — add any env vars your feature needs`)
  step(3, `Write your tests in ${ansiPath(`e2e/${name}.spec.ts`)} (read env with ${ansiPath('process.env.VAR_NAME')} in helpers)`)
  step(4, 'Run: npx canary-lab run')
  line()
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
