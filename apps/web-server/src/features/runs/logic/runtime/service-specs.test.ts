import { describe, it, expect } from 'vitest'
import { resolvePortEnv, collectPortSlots, bootsServicesForEnv, buildServiceSpecs } from './service-specs'
import { computePortPreflight } from './port-preflight'
import type { FeatureConfig } from '../../../../../../../shared/launcher/types'

describe('service selection across readiness, allocation, and boot', () => {
  const feature: FeatureConfig = {
    name: 'shop', description: '', featureDir: '/features/shop', envs: ['local', 'remote'],
    repos: [
      { name: 'empty', localPath: '/repos/empty' },
      { name: 'off', localPath: '/repos/off', envs: ['remote'], startCommands: ['remote-only'] },
      { name: 'web', localPath: '/repos/web', startCommands: [
        { command: 'hidden', envs: ['remote'], ports: [{ name: 'hidden' }] },
        'plain',
        { command: 'first', ports: [{ name: 'shared', env: 'FIRST' }] },
        { command: 'second', name: 'named', ports: [{ name: 'shared', env: 'SECOND' }] },
      ] },
    ],
  }

  it.each([
    ['local', ['web-cmd-2', 'web-cmd-3', 'named'], ['shared']],
    ['remote', ['off-cmd-1', 'web-cmd-1', 'web-cmd-2', 'web-cmd-3', 'named'], ['hidden', 'shared']],
    [undefined, ['off-cmd-1', 'web-cmd-1', 'web-cmd-2', 'web-cmd-3', 'named'], ['hidden', 'shared']],
  ] as const)('agrees on enabled commands for env %s without renumbering them', (env, names, ports) => {
    const preflight = computePortPreflight(feature, env)
    const specs = buildServiceSpecs(feature, '/runs/run-1', env)
    expect(preflight.repos.flatMap((repo) => repo.commands.map((command) => command.name))).toEqual(names)
    expect(specs.map((spec) => spec.name)).toEqual(names)
    expect(collectPortSlots(feature, env).map((slot) => slot.name)).toEqual(ports)
    expect(collectPortSlots(feature, env).find((slot) => slot.name === 'shared')).toEqual({ name: 'shared', env: 'FIRST' })
    expect(bootsServicesForEnv(feature, env)).toBe(true)
    // The current readiness rule is any declared slot, not every command having one.
    expect(preflight.portsConfigured).toBe(true)
  })

  it('agrees when every command is disabled', () => {
    const remoteOnly: FeatureConfig = { ...feature, repos: [feature.repos![1]] }
    expect(computePortPreflight(remoteOnly, 'local')).toEqual({ portsConfigured: true, repos: [] })
    expect(collectPortSlots(remoteOnly, 'local')).toEqual([])
    expect(bootsServicesForEnv(remoteOnly, 'local')).toBe(false)
    expect(buildServiceSpecs(remoteOnly, '/runs/run-1', 'local')).toEqual([])
  })
})

// The port-slot half of buildServiceSpecs, which the orchestrator's own tests
// only ever reached through a full spec build. Both are pure, so the empty and
// declined-env shapes are worth pinning directly.

describe('resolvePortEnv', () => {
  it('is empty when the command declares no ports', () => {
    expect(resolvePortEnv(undefined, new Map([['api', 3000]]))).toEqual({ env: {}, allocatedPorts: {} })
  })

  it('is empty when nothing has been allocated yet', () => {
    expect(resolvePortEnv([{ name: 'api', env: 'PORT' }], undefined)).toEqual({ env: {}, allocatedPorts: {} })
  })

  it('skips a slot with no allocation and keeps the ones that have one', () => {
    const out = resolvePortEnv(
      [{ name: 'api', env: 'PORT' }, { name: 'web', env: 'WEB_PORT' }],
      new Map([['web', 4100]]),
    )
    expect(out).toEqual({ env: { WEB_PORT: '4100' }, allocatedPorts: { web: 4100 } })
  })

  it('records the allocation even when the slot names no env var to inject it into', () => {
    const out = resolvePortEnv([{ name: 'api' }], new Map([['api', 3000]]))
    expect(out).toEqual({ env: {}, allocatedPorts: { api: 3000 } })
  })
})

describe('collectPortSlots', () => {
  const feature = (over: Partial<FeatureConfig> = {}): FeatureConfig => ({
    name: 'demo',
    description: 'demo',
    envs: ['local', 'staging'],
    featureDir: '/features/demo',
    repos: [],
    ...over,
  })

  it('is empty for a feature that declares no repos', () => {
    expect(collectPortSlots(feature({ repos: undefined }))).toEqual([])
  })

  it('dedupes a slot declared by more than one command', () => {
    const slots = collectPortSlots(feature({
      repos: [{
        name: 'api',
        localPath: '/repos/api',
        startCommands: [
          { command: 'a', name: 'a', ports: [{ name: 'api', env: 'PORT' }] },
          { command: 'b', name: 'b', ports: [{ name: 'api', env: 'PORT' }, { name: 'web', env: 'WEB' }] },
        ],
      }],
    }))
    expect(slots.map((s) => s.name)).toEqual(['api', 'web'])
  })

  it('skips repos and commands that are switched off for the requested env', () => {
    const slots = collectPortSlots(feature({
      repos: [
        {
          name: 'api',
          localPath: '/repos/api',
          envs: ['staging'],
          startCommands: [{ command: 'a', name: 'a', ports: [{ name: 'never', env: 'N' }] }],
        },
        {
          name: 'web',
          localPath: '/repos/web',
          startCommands: [
            { command: 'b', name: 'b', envs: ['staging'], ports: [{ name: 'also-never', env: 'A' }] },
            { command: 'c', name: 'c', ports: [{ name: 'kept', env: 'K' }] },
          ],
        },
      ],
    }), 'local')
    expect(slots.map((s) => s.name)).toEqual(['kept'])
  })

  it('tolerates a repo that declares no start commands at all', () => {
    expect(collectPortSlots(feature({
      repos: [{ name: 'api', localPath: '/repos/api' }],
    }))).toEqual([])
  })

  it('tolerates a command that declares no ports at all', () => {
    const slots = collectPortSlots(feature({
      repos: [{ name: 'api', localPath: '/repos/api', startCommands: [{ command: 'a', name: 'a' }] }],
    }))
    expect(slots).toEqual([])
  })
})

describe('bootsServicesForEnv', () => {
  const feature = (repos: FeatureConfig['repos']): FeatureConfig =>
    ({ name: 'checkout', description: '', envs: ['local', 'staging'], featureDir: '/tmp/checkout', repos }) as FeatureConfig

  it('is false for a feature with no repos, or repos without start commands', () => {
    expect(bootsServicesForEnv(feature(undefined), 'local')).toBe(false)
    expect(bootsServicesForEnv(feature([{ name: 'api', localPath: '/repo/api' }]), 'local')).toBe(false)
  })

  it('honours both the repo and the start-command env whitelists', () => {
    const repos: FeatureConfig['repos'] = [
      { name: 'api', localPath: '/repo/api', envs: ['local'], startCommands: ['npm run dev'] },
      { name: 'web', localPath: '/repo/web', startCommands: [{ command: 'npm run web', envs: ['local'] }] },
    ]
    expect(bootsServicesForEnv(feature(repos), 'local')).toBe(true)
    expect(bootsServicesForEnv(feature(repos), 'staging')).toBe(false)
    // No selected env means no filtering, exactly as buildServiceSpecs treats it.
    expect(bootsServicesForEnv(feature(repos), undefined)).toBe(true)
  })
})
