import { describe, it, expect, vi, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  isValidFeatureName,
  buildFeatureConfig,
  buildPlaywrightConfig,
  buildEnvsetsConfig,
  buildSpec,
  main,
} from './new-feature'

const tmpDirs: string[] = []
function mkProjectRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-nf-'))
  tmpDirs.push(dir)
  const root = fs.realpathSync(dir)
  fs.mkdirSync(path.join(root, 'features'))
  return root
}

afterEach(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true })
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('isValidFeatureName', () => {
  it('accepts snake_case starting with a letter', () => {
    expect(isValidFeatureName('cns_webhooks')).toBe(true)
    expect(isValidFeatureName('a')).toBe(true)
    expect(isValidFeatureName('a1_2_3')).toBe(true)
  })

  it('rejects uppercase, leading digits, dashes, and empty', () => {
    expect(isValidFeatureName('CnsWebhooks')).toBe(false)
    expect(isValidFeatureName('1abc')).toBe(false)
    expect(isValidFeatureName('ab-cd')).toBe(false)
    expect(isValidFeatureName('')).toBe(false)
    expect(isValidFeatureName('ab cd')).toBe(false)
  })
})

describe('buildFeatureConfig', () => {
  it('snapshots output for a typical input', () => {
    expect(buildFeatureConfig('cns_webhooks', 'CNS webhook flows'))
      .toMatchInlineSnapshot(`
      "const config = {
        name: 'cns_webhooks',
        description: 'CNS webhook flows',
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
      "
    `)
  })
})

describe('buildPlaywrightConfig', () => {
  it('returns stable content', () => {
    expect(buildPlaywrightConfig()).toMatchInlineSnapshot(`
      "import path from 'node:path'
      import { config as loadDotenv } from 'dotenv'
      import { defineConfig } from '@playwright/test'
      import { baseConfig } from 'canary-lab/feature-support/playwright-base'

      loadDotenv({ path: path.join(__dirname, '.env') })

      export default defineConfig({ ...baseConfig })
      "
    `)
  })
})

describe('buildEnvsetsConfig', () => {
  it('produces valid JSON ending with a newline', () => {
    const out = buildEnvsetsConfig('cns_webhooks')
    expect(out.endsWith('\n')).toBe(true)
    const parsed = JSON.parse(out)
    expect(parsed.slots['cns_webhooks.env']).toBeDefined()
    expect(parsed.slots['cns_webhooks.env'].target).toBe(
      '$CANARY_LAB_PROJECT_ROOT/features/cns_webhooks/.env',
    )
    expect(parsed.feature.slots).toEqual(['cns_webhooks.env'])
    expect(parsed.feature.testCommand).toBe('npx playwright test')
    expect(parsed.feature.testCwd).toBe('$CANARY_LAB_PROJECT_ROOT/features/cns_webhooks')
    expect(parsed.appRoots).toEqual({})
  })
})

describe('buildSpec', () => {
  it('wraps the feature name in a describe block', () => {
    expect(buildSpec('cns_webhooks')).toMatchInlineSnapshot(`
      "import { test, expect } from 'canary-lab/feature-support/log-marker-fixture'

      test.describe('cns_webhooks', () => {
        test('example test', async () => {
          expect(true).toBe(true)
        })
      })
      "
    `)
  })
})

describe("main (new-feature orchestration)", () => {
  it("writes all expected files under features/<name>/ and creates e2e/helpers", async () => {
    const root = mkProjectRoot()
    vi.stubEnv("CANARY_LAB_PROJECT_ROOT", root)
    vi.spyOn(console, "log").mockImplementation(() => {})

    await main(["cns_webhooks", "my", "description"])

    const featDir = path.join(root, "features", "cns_webhooks")
    const expected = [
      "feature.config.cjs",
      "playwright.config.ts",
      "envsets/envsets.config.json",
      "envsets/local/cns_webhooks.env",
      "e2e/cns_webhooks.spec.ts",
    ]
    for (const rel of expected) {
      expect(fs.existsSync(path.join(featDir, rel))).toBe(true)
    }
    expect(fs.existsSync(path.join(featDir, "e2e", "helpers"))).toBe(true)
    expect(fs.existsSync(path.join(featDir, "src"))).toBe(false)

    // feature.config.cjs embeds description verbatim
    const cfg = fs.readFileSync(path.join(featDir, "feature.config.cjs"), "utf-8")
    expect(cfg).toContain("description: 'my description'")
    expect(cfg).toContain("name: 'cns_webhooks'")

    // envsets.config.json references the feature name
    const envsets = JSON.parse(
      fs.readFileSync(path.join(featDir, "envsets/envsets.config.json"), "utf-8"),
    )
    expect(envsets.feature.testCwd).toBe("$CANARY_LAB_PROJECT_ROOT/features/cns_webhooks")
  })

  it("defaults description when none provided", async () => {
    const root = mkProjectRoot()
    vi.stubEnv("CANARY_LAB_PROJECT_ROOT", root)
    vi.spyOn(console, "log").mockImplementation(() => {})
    await main(["plain_feat"])
    const cfg = fs.readFileSync(
      path.join(root, "features", "plain_feat", "feature.config.cjs"),
      "utf-8",
    )
    expect(cfg).toContain("TODO: add description")
  })

  it("exits 1 when no name argument", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    const exit = vi.spyOn(process, "exit").mockImplementation(((c?: number) => {
      throw new Error("__exit__" + c)
    }) as never)
    await expect(main([])).rejects.toThrow("__exit__1")
    expect(err).toHaveBeenCalledWith(expect.stringContaining("Usage:"))
  })

  it("exits 1 when name is invalid (not snake_case)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    vi.spyOn(process, "exit").mockImplementation(((c?: number) => {
      throw new Error("__exit__" + c)
    }) as never)
    await expect(main(["BadName"])).rejects.toThrow("__exit__1")
  })

  it("exits 1 when the target feature dir already exists", async () => {
    const root = mkProjectRoot()
    vi.stubEnv("CANARY_LAB_PROJECT_ROOT", root)
    fs.mkdirSync(path.join(root, "features", "dupe"))

    vi.spyOn(console, "error").mockImplementation(() => {})
    vi.spyOn(process, "exit").mockImplementation(((c?: number) => {
      throw new Error("__exit__" + c)
    }) as never)
    await expect(main(["dupe"])).rejects.toThrow("__exit__1")
  })
})
