import { describe, it, expect, vi, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { main, planFeatureMigration, rewriteHelper } from './migrate'

const tmpDirs: string[] = []

function mkProjectRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-mig-'))
  tmpDirs.push(dir)
  const root = fs.realpathSync(dir)
  fs.mkdirSync(path.join(root, 'features'))
  return root
}

function writeLegacyFeature(
  root: string,
  name: string,
  port: number,
  overrides: Partial<{
    config: string
    playwright: string
    apiHelper: string
    extraHelpers: Record<string, string>
  }> = {},
): string {
  const featDir = path.join(root, 'features', name)
  fs.mkdirSync(path.join(featDir, 'src'), { recursive: true })
  fs.mkdirSync(path.join(featDir, 'e2e', 'helpers'), { recursive: true })

  const config =
    overrides.config ??
    `import path from 'node:path'
import { config as loadDotenv } from 'dotenv'

loadDotenv({ path: path.join(__dirname, '..', '.env') })

export const GATEWAY_URL = process.env.GATEWAY_URL ?? 'http://localhost:${port}'
`
  fs.writeFileSync(path.join(featDir, 'src', 'config.ts'), config)

  const playwright =
    overrides.playwright ??
    `import { defineConfig } from '@playwright/test'
import { baseConfig } from 'canary-lab/feature-support/playwright-base'

export default defineConfig({ ...baseConfig })
`
  fs.writeFileSync(path.join(featDir, 'playwright.config.ts'), playwright)

  const apiHelper =
    overrides.apiHelper ??
    `import { GATEWAY_URL } from '../../src/config'

export class Api {
  baseUrl = GATEWAY_URL
}
`
  fs.writeFileSync(path.join(featDir, 'e2e', 'helpers', 'api.ts'), apiHelper)

  for (const [fname, body] of Object.entries(overrides.extraHelpers ?? {})) {
    fs.writeFileSync(path.join(featDir, 'e2e', 'helpers', fname), body)
  }

  return featDir
}

afterEach(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true })
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('rewriteHelper', () => {
  it('drops the src/config import and inlines GATEWAY_URL with the default URL', () => {
    const src = `import { GATEWAY_URL } from '../../src/config'

export class Api {
  baseUrl = GATEWAY_URL
}
`
    const result = rewriteHelper(src, 'http://localhost:4000')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.content).toBe(
        `export class Api {
  baseUrl = process.env.GATEWAY_URL ?? 'http://localhost:4000'
}
`,
      )
    }
  })

  it('replaces every occurrence of the bare identifier', () => {
    const src = `import { GATEWAY_URL } from '../../src/config'

const a = GATEWAY_URL
const b = GATEWAY_URL + '/x'
`
    const result = rewriteHelper(src, 'http://h:1')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.content).toContain("const a = process.env.GATEWAY_URL ?? 'http://h:1'")
      expect(result.content).toContain(
        "const b = process.env.GATEWAY_URL ?? 'http://h:1' + '/x'",
      )
    }
  })

  it('rejects an import that pulls in identifiers other than GATEWAY_URL', () => {
    const src = `import { GATEWAY_URL, OTHER } from '../../src/config'

export const x = GATEWAY_URL
`
    const result = rewriteHelper(src, 'http://h:1')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toMatch(/expected.*GATEWAY_URL/)
    }
  })

  it('rejects a non-matching import shape', () => {
    const src = `import * as cfg from '../../src/config'

export const x = cfg.GATEWAY_URL
`
    const result = rewriteHelper(src, 'http://h:1')
    expect(result.ok).toBe(false)
  })
})

describe('planFeatureMigration', () => {
  it('plans writes + deletes for a canonical 0.8.0 feature', () => {
    const root = mkProjectRoot()
    const featDir = writeLegacyFeature(root, 'example', 4000)
    const result = planFeatureMigration(featDir)
    expect(result.ok).toBe(true)
    if (result.ok) {
      const writePaths = result.plan.writes.map((w) => path.relative(featDir, w.filePath))
      expect(writePaths).toContain('playwright.config.ts')
      expect(writePaths).toContain(path.join('e2e', 'helpers', 'api.ts'))

      const playwright = result.plan.writes.find((w) =>
        w.filePath.endsWith('playwright.config.ts'),
      )!
      expect(playwright.content).toContain("import { config as loadDotenv } from 'dotenv'")
      expect(playwright.content).toContain("loadDotenv({ path: path.join(__dirname, '.env') })")

      const api = result.plan.writes.find((w) => w.filePath.endsWith('api.ts'))!
      expect(api.content).not.toContain("from '../../src/config'")
      expect(api.content).toContain("process.env.GATEWAY_URL ?? 'http://localhost:4000'")

      const deletePaths = result.plan.deletes.map((d) => path.relative(featDir, d.filePath))
      expect(deletePaths).toEqual([path.join('src', 'config.ts'), 'src'])
    }
  })

  it('skips when src/config.ts has extra exports', () => {
    const root = mkProjectRoot()
    const featDir = writeLegacyFeature(root, 'modded', 4000, {
      config: `import path from 'node:path'
import { config as loadDotenv } from 'dotenv'

loadDotenv({ path: path.join(__dirname, '..', '.env') })

export const GATEWAY_URL = process.env.GATEWAY_URL ?? 'http://localhost:4000'
export const EXTRA = 'custom'
`,
    })
    const result = planFeatureMigration(featDir)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toMatch(/src\/config\.ts/)
    }
  })

  it('skips when playwright.config.ts has been modified', () => {
    const root = mkProjectRoot()
    const featDir = writeLegacyFeature(root, 'modded', 4000, {
      playwright: `import { defineConfig } from '@playwright/test'
import { baseConfig } from 'canary-lab/feature-support/playwright-base'

export default defineConfig({ ...baseConfig, workers: 2 })
`,
    })
    const result = planFeatureMigration(featDir)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toMatch(/playwright\.config\.ts/)
    }
  })

  it('skips when a helper imports something other than GATEWAY_URL from src/config', () => {
    const root = mkProjectRoot()
    const featDir = writeLegacyFeature(root, 'weird', 4000, {
      apiHelper: `import { GATEWAY_URL, OTHER } from '../../src/config'

export class Api { x = GATEWAY_URL; y = OTHER }
`,
    })
    const result = planFeatureMigration(featDir)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toMatch(/e2e\/helpers\/api\.ts/)
    }
  })

  it('only processes helpers that import from src/config; leaves others alone', () => {
    const root = mkProjectRoot()
    const featDir = writeLegacyFeature(root, 'example', 4000, {
      extraHelpers: {
        'fixtures.ts': `export const data = { a: 1 }\n`,
      },
    })
    const result = planFeatureMigration(featDir)
    expect(result.ok).toBe(true)
    if (result.ok) {
      const writePaths = result.plan.writes.map((w) => path.relative(featDir, w.filePath))
      expect(writePaths).not.toContain(path.join('e2e', 'helpers', 'fixtures.ts'))
    }
  })
})

describe('main (migrate orchestration)', () => {
  it('migrates a canonical 0.8.0 feature end-to-end', async () => {
    const root = mkProjectRoot()
    vi.stubEnv('CANARY_LAB_PROJECT_ROOT', root)
    writeLegacyFeature(root, 'example', 4000)
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main([])

    const featDir = path.join(root, 'features', 'example')
    expect(fs.existsSync(path.join(featDir, 'src'))).toBe(false)
    const playwright = fs.readFileSync(path.join(featDir, 'playwright.config.ts'), 'utf-8')
    expect(playwright).toContain("loadDotenv({ path: path.join(__dirname, '.env') })")
    const api = fs.readFileSync(path.join(featDir, 'e2e', 'helpers', 'api.ts'), 'utf-8')
    expect(api).not.toContain("from '../../src/config'")
    expect(api).toContain("process.env.GATEWAY_URL ?? 'http://localhost:4000'")
  })

  it('is idempotent — running twice is a no-op on the second run', async () => {
    const root = mkProjectRoot()
    vi.stubEnv('CANARY_LAB_PROJECT_ROOT', root)
    writeLegacyFeature(root, 'example', 4000)
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main([])
    const pwAfterFirst = fs.readFileSync(
      path.join(root, 'features', 'example', 'playwright.config.ts'),
      'utf-8',
    )
    await main([])
    const pwAfterSecond = fs.readFileSync(
      path.join(root, 'features', 'example', 'playwright.config.ts'),
      'utf-8',
    )
    expect(pwAfterSecond).toBe(pwAfterFirst)
  })

  it('dry-run reports changes but touches no files', async () => {
    const root = mkProjectRoot()
    vi.stubEnv('CANARY_LAB_PROJECT_ROOT', root)
    writeLegacyFeature(root, 'example', 4000)
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['--dry-run'])

    const featDir = path.join(root, 'features', 'example')
    expect(fs.existsSync(path.join(featDir, 'src', 'config.ts'))).toBe(true)
    const playwright = fs.readFileSync(path.join(featDir, 'playwright.config.ts'), 'utf-8')
    expect(playwright).not.toContain('loadDotenv')
  })

  it('reports nothing to migrate when no legacy features exist', async () => {
    const root = mkProjectRoot()
    vi.stubEnv('CANARY_LAB_PROJECT_ROOT', root)
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main([])

    const out = logSpy.mock.calls.map((c) => c[0]).join('\n')
    expect(out).toContain('Nothing to migrate')
  })

  it('migrates some features and skips others in the same run', async () => {
    const root = mkProjectRoot()
    vi.stubEnv('CANARY_LAB_PROJECT_ROOT', root)
    writeLegacyFeature(root, 'clean', 4000)
    writeLegacyFeature(root, 'modded', 4100, {
      playwright: `import { defineConfig } from '@playwright/test'

export default defineConfig({})
`,
    })
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main([])

    // clean was migrated
    expect(fs.existsSync(path.join(root, 'features', 'clean', 'src'))).toBe(false)
    // modded was skipped
    expect(
      fs.existsSync(path.join(root, 'features', 'modded', 'src', 'config.ts')),
    ).toBe(true)
  })

  it('exits 1 with a clear error when features/ is missing', async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-mig-nofeat-'))
    tmpDirs.push(rootDir)
    const root = fs.realpathSync(rootDir)
    vi.stubEnv('CANARY_LAB_PROJECT_ROOT', root)

    vi.spyOn(console, 'log').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(((code?: number) => {
        throw new Error(`__exit__${code}`)
      }) as never)

    await expect(main([])).rejects.toThrow('__exit__1')
    exitSpy.mockRestore()
    errSpy.mockRestore()
  })

  it('extracts per-feature port defaults correctly (4000, 4100, 4200, 4300)', async () => {
    const root = mkProjectRoot()
    vi.stubEnv('CANARY_LAB_PROJECT_ROOT', root)
    writeLegacyFeature(root, 'a', 4000)
    writeLegacyFeature(root, 'b', 4100)
    writeLegacyFeature(root, 'c', 4200)
    writeLegacyFeature(root, 'd', 4300)
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main([])

    for (const [name, port] of [
      ['a', 4000],
      ['b', 4100],
      ['c', 4200],
      ['d', 4300],
    ] as const) {
      const api = fs.readFileSync(
        path.join(root, 'features', name, 'e2e', 'helpers', 'api.ts'),
        'utf-8',
      )
      expect(api).toContain(`process.env.GATEWAY_URL ?? 'http://localhost:${port}'`)
    }
  })
})
