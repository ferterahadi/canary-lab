import { describe, it, expect } from 'vitest'
import { resolvePortEnv, collectPortSlots } from './service-specs'
import type { FeatureConfig } from '../../../../../../../shared/launcher/types'

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
