import { describe, expect, it, beforeEach, afterEach } from 'vitest'

import fs from 'fs'

import os from 'os'

import path from 'path'

import type { FeatureConfig } from '../../../../../../shared/launcher/types'

import {
  buildVerificationDiagnostics,
  createVerificationConfig,
  deriveVerificationTargets,
  getVerificationConfig,
  listVerificationConfigs,
  resolveVerificationRun,
  updateVerificationConfig,
} from './verification'

let tmpDir: string

let featureDir: string

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-verify-')))
  featureDir = path.join(tmpDir, 'features', 'checkout')
  fs.mkdirSync(featureDir, { recursive: true })
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function feature(): FeatureConfig {
  return {
    name: 'checkout',
    description: 'checkout',
    envs: ['local', 'production'],
    featureDir,
    repos: [
      {
        name: 'api',
        localPath: featureDir,
        startCommands: [
          {
            name: 'api-server',
            command: 'npm run dev',
            envs: ['local'],
            healthCheck: {
              local: { http: { url: 'http://localhost:4000/' } },
              production: { http: { url: 'https://api.example.com/healthz' } },
            },
          },
        ],
      },
    ],
  }
}

function writeEnvset(env: string, contents: string): void {
  const dir = path.join(featureDir, 'envsets', env)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'checkout.env'), contents)
}

describe('verification targets', () => {
  it('derives stable target ids from start command names and maps envset URL vars', () => {
    writeEnvset('production', 'GATEWAY_URL=https://api.example.com\n')

    const index = deriveVerificationTargets(feature(), 'production')

    expect(index.targets).toEqual([
      {
        id: 'api-server',
        name: 'api',
        envVar: 'GATEWAY_URL',
      },
    ])
    expect(index.targetUrls).toEqual({
      'api-server': 'https://api.example.com',
    })
  })

  it('derives fallback targets from repos, health checks, duplicate names, nested envsets, and default env URLs', () => {
    writeEnvset('production', [
      '# comments and blank lines are ignored',
      '',
      'API_SERVER_URL="https://api.env.example.com"',
      'PUBLIC_API_SERVER_URL=https://api-fuzzy.example.com',
      'ADMIN_TARGET_URL=https://admin.example.com',
      'TOKEN=not-a-url',
      'DOCS_URL=ftp://docs.example.com',
      'NOT_TARGET=https://ignored.example.com',
      ' =https://missing-key.example.com',
      'BROKEN_LINE',
    ].join('\n'))
    fs.mkdirSync(path.join(featureDir, 'envsets', 'production', 'nested'), { recursive: true })
    fs.writeFileSync(path.join(featureDir, 'envsets', 'production', 'empty.env'), '')
    fs.writeFileSync(
      path.join(featureDir, 'envsets', 'production', 'nested', 'admin.env'),
      "ADMIN_PANEL_URL='https://admin-nested.example.com'\n",
    )
    fs.symlinkSync(
      path.join(featureDir, 'envsets', 'production', 'checkout.env'),
      path.join(featureDir, 'envsets', 'production', 'link.env'),
    )
    const f: FeatureConfig = {
      ...feature(),
      repos: [
        { name: 'api', localPath: featureDir },
        {
          name: 'gateway',
          localPath: featureDir,
          startCommands: [
            {
              name: 'api-server',
              command: 'npm run api',
              healthCheck: { production: { http: { url: 'https://health.example.com' } } },
            },
            {
              name: 'api-server',
              command: 'npm run api-2',
            },
            {
              command: 'npm run admin',
              healthCheck: { production: { http: { url: 'https://admin-health.example.com' } } },
            },
            {
              name: '!!!',
              command: 'npm run unnamed',
            },
            {
              name: 'tcp-only',
              command: 'npm run tcp',
              healthCheck: { production: { tcp: { port: 4000 } } },
            },
          ],
        },
      ],
    }

    const index = deriveVerificationTargets(f, 'production')

    expect(index.targets).toEqual([
      { id: 'api', name: 'api', envVar: 'API_SERVER_URL' },
      { id: 'api-server', name: 'gateway', envVar: 'API_SERVER_URL' },
      { id: 'api-server-2', name: 'gateway', envVar: 'API_SERVER_URL' },
      { id: 'gateway-cmd-3', name: 'gateway' },
      { id: 'service', name: 'gateway' },
      { id: 'tcp-only', name: 'gateway' },
    ])
    expect(index.targetUrls).toEqual({
      api: 'https://api.env.example.com',
      'api-server': 'https://api.env.example.com',
      'api-server-2': 'https://api.env.example.com',
      'gateway-cmd-3': 'https://admin-health.example.com',
    })
  })

  it('matches fuzzy TARGET_URL env vars for command targets', () => {
    writeEnvset('production', 'UPSTREAM_PUBLIC_API_TARGET_URL=https://public.example.com\nAPI_SERVER_URL=https://api.example.com\n')
    const f: FeatureConfig = {
      ...feature(),
      repos: [
        {
          name: 'api',
          localPath: featureDir,
          startCommands: [
            { name: 'public-api', command: 'npm run public' },
          ],
        },
      ],
    }

    expect(deriveVerificationTargets(f, 'production')).toEqual({
      targets: [{ id: 'public-api', name: 'api', envVar: 'UPSTREAM_PUBLIC_API_TARGET_URL' }],
      targetUrls: { 'public-api': 'https://public.example.com' },
    })
  })

  it('falls back to default targets when a feature has no repos', () => {
    writeEnvset('production', 'GATEWAY_URL=https://gateway.example.com\n')
    const f: FeatureConfig = {
      name: 'empty',
      description: 'empty',
      envs: ['production'],
      featureDir,
    }

    expect(deriveVerificationTargets(f, 'production')).toEqual({
      targets: [{ id: 'default', name: 'Default target', envVar: 'GATEWAY_URL' }],
      targetUrls: { default: 'https://gateway.example.com' },
    })
    expect(deriveVerificationTargets(f, 'missing')).toEqual({
      targets: [{ id: 'default', name: 'Default target' }],
      targetUrls: {},
    })
    expect(deriveVerificationTargets(f, undefined)).toEqual({
      targets: [{ id: 'default', name: 'Default target' }],
      targetUrls: {},
    })
  })
})

describe('verification configs', () => {
  it('creates, lists, updates, and resolves saved verification configs', () => {
    writeEnvset('production', 'GATEWAY_URL=https://api.example.com\n')
    const f = feature()

    const created = createVerificationConfig(f, {
      name: 'Beta',
      playwrightEnvsetId: 'production',
      targetUrls: { 'api-server': 'https://beta.example.com' },
    })
    expect(listVerificationConfigs(f)).toEqual([created])

    const updated = updateVerificationConfig(f, created.id, {
      name: 'Staging',
      playwrightEnvsetId: 'production',
      targetUrls: { 'api-server': 'https://staging.example.com' },
    })
    expect(updated?.name).toBe('Staging')

    const resolved = resolveVerificationRun(f, { configId: created.id })
    expect(resolved.metadata).toMatchObject({
      configId: created.id,
      configName: 'Staging',
      playwrightEnvsetId: 'production',
      targetUrls: { 'api-server': 'https://staging.example.com' },
      targets: [
        {
          id: 'api-server',
          name: 'api',
          envVar: 'GATEWAY_URL',
          url: 'https://staging.example.com',
        },
      ],
    })
    expect(resolved.playwrightEnv).toEqual({
      GATEWAY_URL: 'https://staging.example.com',
    })
  })

  it('sanitizes config input, filters invalid saved configs, and reports missing configs', () => {
    const f = feature()
    const created = createVerificationConfig(f, {
      name: '  Beta  ',
      playwrightEnvsetId: ' production ',
      targetUrls: { ' api-server ': ' https://beta.example.com ', empty: '', '   ': 'https://ignored.example.com' },
    })
    const configPath = path.join(featureDir, 'verification.configs.json')
    const stored = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
    stored.configs.push(
      null,
      { id: 42 },
      { id: 'missing-targets', featureId: 'checkout', name: 'Bad', playwrightEnvsetId: 'production', createdAt: 'x', updatedAt: 'x' },
    )
    fs.writeFileSync(configPath, JSON.stringify(stored))

    expect(listVerificationConfigs(f)).toEqual([created])
    expect(created).toMatchObject({
      name: 'Beta',
      playwrightEnvsetId: 'production',
      targetUrls: { 'api-server': 'https://beta.example.com' },
    })
    expect(getVerificationConfig(f, 'missing')).toBeNull()
    expect(updateVerificationConfig(f, 'missing', {
      name: 'Missing',
      playwrightEnvsetId: 'production',
      targetUrls: {},
    })).toBeNull()
    expect(() => createVerificationConfig(f, {
      name: '   ',
      playwrightEnvsetId: 'production',
      targetUrls: {},
    })).toThrow('verification config name is required')

    expect(createVerificationConfig(f, {
      name: 'Nullish',
      playwrightEnvsetId: 'production',
      targetUrls: { api: null, web: undefined } as unknown as Record<string, string>,
    }).targetUrls).toEqual({})
    expect(createVerificationConfig(f, {
      name: 'Missing map',
      playwrightEnvsetId: 'production',
      targetUrls: null as unknown as Record<string, string>,
    }).targetUrls).toEqual({})
  })

  it('treats malformed config files as empty', () => {
    fs.writeFileSync(path.join(featureDir, 'verification.configs.json'), '{not json')

    expect(listVerificationConfigs(feature())).toEqual([])

    fs.writeFileSync(path.join(featureDir, 'verification.configs.json'), JSON.stringify({ configs: 'bad' }))
    expect(listVerificationConfigs(feature())).toEqual([])
  })

  it('resolves inline verification runs and rejects missing config or envset input', () => {
    writeEnvset('production', 'GATEWAY_URL=https://api.example.com\n')
    const f = feature()

    const resolved = resolveVerificationRun(f, {
      playwrightEnvsetId: 'production',
      targetUrls: { 'api-server': 'https://override.example.com', ignored: '' },
    })

    expect(resolved.config).toBeUndefined()
    expect(resolved.metadata).toMatchObject({
      playwrightEnvsetId: 'production',
      targetUrls: { 'api-server': 'https://override.example.com' },
      targets: [{ id: 'api-server', url: 'https://override.example.com' }],
    })
    expect(resolved.playwrightEnv).toEqual({ GATEWAY_URL: 'https://override.example.com' })
    expect(() => resolveVerificationRun(f, { configId: 'missing' })).toThrow('verification config not found: missing')
    expect(() => resolveVerificationRun({ ...f, envs: [] }, {})).toThrow('playwrightEnvsetId is required for verification')
  })

  it('does not export playwright env vars for saved targets with blank URLs', () => {
    writeEnvset('production', 'GATEWAY_URL=https://api.example.com\n')
    const configPath = path.join(featureDir, 'verification.configs.json')
    fs.writeFileSync(configPath, JSON.stringify({
      configs: [
        {
          id: 'blank-url',
          featureId: 'checkout',
          name: 'Blank URL',
          targetUrls: { 'api-server': '' },
          playwrightEnvsetId: 'production',
          createdAt: '2026-05-24T00:00:00.000Z',
          updatedAt: '2026-05-24T00:00:00.000Z',
        },
      ],
    }))

    const resolved = resolveVerificationRun(feature(), { configId: 'blank-url' })

    expect(resolved.metadata.targets).toEqual([
      { id: 'api-server', name: 'api', envVar: 'GATEWAY_URL', url: '' },
    ])
    expect(resolved.playwrightEnv).toEqual({})
  })

  it('uses the first feature env as the verification envset fallback', () => {
    writeEnvset('local', 'GATEWAY_URL=https://local.example.com\n')

    const resolved = resolveVerificationRun(feature(), {})

    expect(resolved.metadata.playwrightEnvsetId).toBe('local')
    expect(resolved.playwrightEnv).toEqual({ GATEWAY_URL: 'https://local.example.com' })
  })

  it('keeps target snapshots when no URL can be resolved', () => {
    const f: FeatureConfig = {
      name: 'checkout',
      description: 'checkout',
      envs: ['production'],
      featureDir,
      repos: [
        { name: 'api', localPath: featureDir },
      ],
    }

    const resolved = resolveVerificationRun(f, { playwrightEnvsetId: 'production' })

    expect(resolved.metadata.targets).toEqual([{ id: 'api', name: 'api', url: '' }])
    expect(resolved.playwrightEnv).toEqual({})
  })
})
