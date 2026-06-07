import { describe, expect, it } from 'vitest'
import type { FeatureConfig } from '../../../../shared/launcher/types'
import { computePortPreflight } from './port-preflight'

function feature(partial: Partial<FeatureConfig>): FeatureConfig {
  return {
    name: 'f',
    description: 'd',
    envs: ['local'],
    featureDir: '/tmp/f',
    ...partial,
  }
}

describe('computePortPreflight', () => {
  it('reports not-configured when a bootable command declares no port slots', () => {
    const result = computePortPreflight(
      feature({ repos: [{ name: 'svc', localPath: '~/svc', startCommands: ['yarn start'] }] }),
    )
    expect(result.portsConfigured).toBe(false)
    expect(result.repos).toEqual([
      { name: 'svc', commands: [{ name: 'svc-cmd-1', declaredPorts: [] }] },
    ])
  })

  it('reports configured when at least one slot is declared', () => {
    const result = computePortPreflight(
      feature({
        repos: [{
          name: 'svc',
          localPath: '~/svc',
          startCommands: [{ command: 'yarn start', ports: [{ name: 'api', env: 'PORT' }] }],
        }],
      }),
    )
    expect(result.portsConfigured).toBe(true)
    expect(result.repos[0].commands[0].declaredPorts).toEqual([{ name: 'api', env: 'PORT' }])
  })

  it('treats a feature with no bootable commands as trivially configured', () => {
    expect(computePortPreflight(feature({ repos: [] })).portsConfigured).toBe(true)
    expect(computePortPreflight(feature({})).portsConfigured).toBe(true)
  })

  it('treats a repo with no start commands as nothing-to-boot (configured, not listed)', () => {
    const result = computePortPreflight(feature({ repos: [{ name: 'svc', localPath: '~/svc' }] }))
    expect(result.portsConfigured).toBe(true)
    expect(result.repos).toEqual([]) // no commands → repo not listed
  })

  it('reports a declared slot that omits its env var (still a slot)', () => {
    const result = computePortPreflight(
      feature({ repos: [{ name: 'svc', localPath: '~/svc', startCommands: [{ command: 'x', ports: [{ name: 'api' }] }] }] }),
    )
    expect(result.portsConfigured).toBe(true)
    expect(result.repos[0].commands[0].declaredPorts).toEqual([{ name: 'api' }])
  })

  it('skips a repo gated out of the selected env entirely', () => {
    const f = feature({
      repos: [{ name: 'svc', localPath: '~/svc', envs: ['local'], startCommands: ['yarn start'] }],
    })
    // In 'production' the whole repo is filtered → nothing to boot → configured.
    expect(computePortPreflight(f, 'production')).toEqual({ portsConfigured: true, repos: [] })
    // In 'local' the repo's slot-less command makes it unconfigured.
    expect(computePortPreflight(f, 'local').portsConfigured).toBe(false)
  })

  it('ignores commands gated out of the selected env', () => {
    const f = feature({
      repos: [{
        name: 'svc',
        localPath: '~/svc',
        startCommands: [{ command: 'yarn start', envs: ['local'] }],
      }],
    })
    // In 'production' the only command is filtered out → nothing to boot → configured.
    expect(computePortPreflight(f, 'production').portsConfigured).toBe(true)
    // In 'local' the command is active but slot-less → not configured.
    expect(computePortPreflight(f, 'local').portsConfigured).toBe(false)
  })
})
