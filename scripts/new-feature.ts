import fs from 'fs'
import path from 'path'

const ROOT = path.resolve(__dirname, '..')
const FEATURES_DIR = path.join(ROOT, 'features')

const args = process.argv.slice(2)
const name = args[0]
const description = args.slice(1).join(' ') || 'TODO: add description'

if (!name) {
  console.error('Usage: yarn new-feature <name> [description]')
  console.error('  Example: yarn new-feature cns_webhooks "Webhook delivery E2E tests"')
  process.exit(1)
}

if (!/^[a-z][a-z0-9_]*$/.test(name)) {
  console.error(`Invalid feature name "${name}". Use snake_case (e.g. cns_webhooks).`)
  process.exit(1)
}

const featureDir = path.join(FEATURES_DIR, name)
if (fs.existsSync(featureDir)) {
  console.error(`Feature "${name}" already exists at ${featureDir}`)
  process.exit(1)
}

// ─── Templates ─────────────────────────────────────────────────────────────

const featureConfig = `import type { FeatureConfig } from '../../shared/launcher/types'

export const config: FeatureConfig = {
  name: '${name}',
  description: '${description}',
  envs: ['local'],
  repos: [
    // {
    //   name: 'your-repo',
    //   localPath: '~/Documents/your-repo',
    //   cloneUrl: 'git@github.com:your-org/your-repo.git',
    //   startCommands: [
    //     {
    //       name: 'your-repo dev server',
    //       command: 'yarn dev',
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
`

const packageJson = JSON.stringify(
  {
    name: `canary-lab-${name}`,
    version: '0.1.0',
    private: true,
    description,
    scripts: {
      start: `tsx ../../shared/env-switcher/switch.ts ${name}`,
      'env:apply': `tsx ../../shared/env-switcher/switch.ts ${name} --apply`,
      'env:revert': `tsx ../../shared/env-switcher/switch.ts ${name} --revert`,
      'test:e2e': 'playwright test',
      'test:e2e:headed': 'playwright test --headed',
      'test:e2e:ui': 'playwright test --ui',
      'install:browsers': 'playwright install chromium',
    },
  },
  null,
  2,
) + '\n'

const playwrightConfig = `import { defineConfig } from '@playwright/test'
import { baseConfig } from '../../shared/configs/playwright.base'

export default defineConfig({
  ...baseConfig,
  // Override defaults as needed:
  // timeout: 180_000,
})
`

const tsconfigJson = JSON.stringify(
  { extends: '../../shared/configs/tsconfig.feature.json' },
  null,
  2,
) + '\n'

const envExample = `# URL of the locally running service
GATEWAY_URL=http://localhost:3000
`

const configTs = `import { loadFeatureEnv } from '../../shared/configs/loadEnv'
loadFeatureEnv(__dirname + '/..')

export const GATEWAY_URL = process.env.GATEWAY_URL ?? 'http://localhost:3000'
// Add more typed exports here
`

const envsetsConfig = JSON.stringify(
  {
    appRoots: {
      CANARY_LAB: ROOT,
    },
    slots: {
      [`${name}.env`]: {
        description: `Canary Lab ${name} feature .env`,
        target: `$CANARY_LAB/features/${name}/.env`,
      },
    },
    feature: {
      slots: [`${name}.env`],
      testCommand: 'yarn test:e2e',
      testCwd: `$CANARY_LAB/features/${name}`,
    },
  },
  null,
  2,
) + '\n'

const localEnv = `GATEWAY_URL=http://localhost:3000
`

const specFile = `import { test, expect } from '@playwright/test'

test.describe('${name}', () => {
  test('example test', async () => {
    // Replace with your actual test logic
    expect(true).toBe(true)
  })
})
`

// ─── Create files ──────────────────────────────────────────────────────────

const files: Array<[string, string]> = [
  ['feature.config.ts', featureConfig],
  ['package.json', packageJson],
  ['playwright.config.ts', playwrightConfig],
  ['tsconfig.json', tsconfigJson],
  ['.env.example', envExample],
  ['src/config.ts', configTs],
  ['envsets/envsets.config.json', envsetsConfig],
  [`envsets/local/${name}.env`, localEnv],
  [`e2e/${name}.spec.ts`, specFile],
]

for (const [relPath, content] of files) {
  const fullPath = path.join(featureDir, relPath)
  fs.mkdirSync(path.dirname(fullPath), { recursive: true })
  fs.writeFileSync(fullPath, content)
}

// Create empty helpers directory
fs.mkdirSync(path.join(featureDir, 'e2e/helpers'), { recursive: true })

console.log(`\n  Feature "${name}" created at features/${name}/\n`)
console.log('  Created files:')
for (const [relPath] of files) {
  console.log(`    features/${name}/${relPath}`)
}
console.log(`    features/${name}/e2e/helpers/`)
console.log('')
console.log('  Next steps:')
console.log('    1. Edit feature.config.ts — add your repos, start commands, and health checks')
console.log('    2. Edit src/config.ts — add feature-specific env var exports')
console.log(`    3. Write your tests in e2e/${name}.spec.ts`)
console.log('    4. Run: yarn e2e')
console.log('')
