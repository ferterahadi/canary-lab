import { describe, expect, it } from 'vitest'
import type { FeatureConfig } from '../../../../../../../shared/launcher/types'
import { declaredPortsForRepo } from './portify-overlay-capture'

const feature = (repos: FeatureConfig['repos']): FeatureConfig => ({
  name: 'f', description: 'd', envs: ['local'], featureDir: '/tmp/f', repos,
})

describe('declaredPortsForRepo', () => {
  it('returns nothing when the feature could not be loaded', () => {
    expect(declaredPortsForRepo(null, 'app')).toEqual([])
  })

  it('returns nothing for a repo this feature does not declare', () => {
    expect(declaredPortsForRepo(feature([{ name: 'other', localPath: '/a' }]), 'app')).toEqual([])
  })

  it('returns nothing for a repo with no start commands', () => {
    expect(declaredPortsForRepo(feature([{ name: 'app', localPath: '/a' }]), 'app')).toEqual([])
  })

  it('collects the slots declared across a repo\'s start commands', () => {
    const f = feature([{
      name: 'app',
      localPath: '/a',
      startCommands: [
        { command: 'node api.js', ports: [{ name: 'api', env: 'PORT' }] },
        { command: 'node grpc.js', ports: [{ name: 'grpc', env: 'GRPC_PORT' }] },
      ],
    }])
    expect(declaredPortsForRepo(f, 'app')).toEqual([{ name: 'api', env: 'PORT' }, { name: 'grpc', env: 'GRPC_PORT' }])
  })

  it('skips a bare-string start command, which cannot declare slots', () => {
    const f = feature([{
      name: 'app',
      localPath: '/a',
      startCommands: ['npm start', { command: 'node api.js', ports: [{ name: 'api', env: 'PORT' }] }],
    }])
    expect(declaredPortsForRepo(f, 'app')).toEqual([{ name: 'api', env: 'PORT' }])
  })

  it('dedupes by slot name — one command that boots a stack can repeat a slot', () => {
    const f = feature([{
      name: 'app',
      localPath: '/a',
      startCommands: [
        { command: 'node a.js', ports: [{ name: 'api', env: 'PORT' }] },
        { command: 'node b.js', ports: [{ name: 'api', env: 'SHOULD_NOT_WIN' }] },
      ],
    }])
    expect(declaredPortsForRepo(f, 'app')).toEqual([{ name: 'api', env: 'PORT' }])
  })

  it('steps over an object start command that declares no ports at all', () => {
    // A not-yet-portified command is an object with no `ports` key, so this is
    // the shape EVERY repo has before its first port-ification — it has to be
    // skipped like a bare string rather than reading as an empty declaration.
    const f = feature([{
      name: 'app',
      localPath: '/a',
      startCommands: [
        { command: 'node worker.js' },
        { command: 'node api.js', ports: [{ name: 'api', env: 'PORT' }] },
      ],
    }])
    expect(declaredPortsForRepo(f, 'app')).toEqual([{ name: 'api', env: 'PORT' }])
  })

  it('reads only the named repo, not the whole feature', () => {
    const f = feature([
      { name: 'app', localPath: '/a', startCommands: [{ command: 'node a.js', ports: [{ name: 'api', env: 'PORT' }] }] },
      { name: 'other', localPath: '/b', startCommands: [{ command: 'node b.js', ports: [{ name: 'ws', env: 'WS_PORT' }] }] },
    ])
    expect(declaredPortsForRepo(f, 'app')).toEqual([{ name: 'api', env: 'PORT' }])
  })
})
