import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { buildServiceSpecs, buildQueuedServiceEntries, collectPortSlots } from './orchestrator'
import type { FeatureConfig } from '../../../../../../../shared/launcher/types'
import { runDirFor, buildRunPaths } from './run-paths'

let tmpDir: string

let runDir: string

const RUN_ID = '2026-04-28T1015-aaaa'

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-orc-')))
  runDir = runDirFor(path.join(tmpDir, 'logs'), RUN_ID)
  fs.mkdirSync(runDir, { recursive: true })
})

afterEach(() => {
  vi.useRealTimers()
})

function makeFeature(over: Partial<FeatureConfig> = {}): FeatureConfig {
  return {
    name: 'demo',
    description: 'demo',
    envs: ['local'],
    featureDir: path.join(tmpDir, 'features', 'demo'),
    repos: [
      {
        name: 'api',
        localPath: tmpDir,
        startCommands: [{ command: 'echo hi', name: 'api', healthCheck: { url: 'http://x' } }],
      },
    ],
    ...over,
  }
}

describe('buildServiceSpecs', () => {
  it('flattens repo startCommands into named specs', () => {
    const f = makeFeature({
      repos: [
        {
          name: 'r',
          localPath: tmpDir,
          startCommands: [
            'plain string',
            { command: 'a', name: 'apiA' },
            { command: 'b', healthCheck: { url: 'http://b' } },
          ],
        },
      ],
    })
    const specs = buildServiceSpecs(f, runDir)
    expect(specs).toHaveLength(3)
    expect(specs[0].name).toBe('r-cmd-1')
    expect(specs[1].name).toBe('apiA')
    expect(specs[1]).toMatchObject({ repoName: 'r' })
    // Legacy bare-url shape coerced to tagged http probe.
    expect(specs[2].healthProbe).toEqual({ http: { url: 'http://b', timeoutMs: undefined } })
  })

  it('handles repos without startCommands', () => {
    const f = makeFeature({ repos: [{ name: 'r', localPath: tmpDir }] })
    expect(buildServiceSpecs(f, runDir)).toEqual([])
  })

  it('handles features without repos', () => {
    const f = makeFeature({ repos: undefined })
    expect(buildServiceSpecs(f, runDir)).toEqual([])
  })

  it('includes commands with no envs whitelist regardless of selected env', () => {
    const f = makeFeature({
      repos: [{
        name: 'r',
        localPath: tmpDir,
        startCommands: [{ command: 'a', name: 'apiA' }],
      }],
    })
    expect(buildServiceSpecs(f, runDir, 'production')).toHaveLength(1)
  })

  it('skips commands whose envs whitelist excludes the selected env', () => {
    const f = makeFeature({
      repos: [{
        name: 'r',
        localPath: tmpDir,
        startCommands: [
          { command: 'a', name: 'apiLocal', envs: ['local'] },
          { command: 'b', name: 'apiAll' },
        ],
      }],
    })
    const specs = buildServiceSpecs(f, runDir, 'production')
    expect(specs.map((s) => s.name)).toEqual(['apiAll'])
  })

  it('substitutes ${slot.key} tokens in command and probe url from envset slot files', () => {
    const featureDir = path.join(tmpDir, 'features', 'demo')
    fs.mkdirSync(path.join(featureDir, 'envsets', 'local'), { recursive: true })
    fs.writeFileSync(path.join(featureDir, 'envsets', 'local', 'api'), 'PORT=3030\nHOST=api.local\n')
    const f = makeFeature({
      repos: [{
        name: 'r',
        localPath: tmpDir,
        startCommands: [{
          command: 'serve --port ${api.PORT}',
          name: 'svc',
          healthCheck: { http: { url: 'http://${api.HOST}:${api.PORT}/health' } },
        }],
      }],
    })
    const specs = buildServiceSpecs(f, runDir, 'local')
    expect(specs).toHaveLength(1)
    expect(specs[0].command).toBe('serve --port 3030')
    expect(specs[0].healthProbe).toEqual({ http: { url: 'http://api.local:3030/health' } })
  })

  it('leaves unresolvable tokens literal so misconfig is visible at runtime', () => {
    const f = makeFeature({
      repos: [{
        name: 'r',
        localPath: tmpDir,
        startCommands: [{ command: 'echo ${ghost.X}', name: 'svc' }],
      }],
    })
    const specs = buildServiceSpecs(f, runDir, 'local')
    expect(specs[0].command).toBe('echo ${ghost.X}')
  })

  it('injects allocated ports as env + resolves ${port.<slot>} in command and probe', () => {
    const f = makeFeature({
      repos: [{
        name: 'r',
        localPath: tmpDir,
        startCommands: [{
          command: 'serve',
          name: 'svc',
          ports: [{ name: 'api', env: 'PORT' }],
          healthCheck: { http: { url: 'http://localhost:${port.api}/' } },
        }],
      }],
    })
    const portMap = new Map([['api', 51999]])
    const specs = buildServiceSpecs(f, runDir, 'local', { portMap })
    expect(specs[0].env).toEqual({ PORT: '51999' })
    expect(specs[0].allocatedPorts).toEqual({ api: 51999 })
    expect(specs[0].healthProbe).toEqual({ http: { url: 'http://localhost:51999/' } })
  })

  it('declares no port env when no port map is supplied (back-compat)', () => {
    const f = makeFeature({
      repos: [{
        name: 'r',
        localPath: tmpDir,
        startCommands: [{ command: 'serve', name: 'svc', ports: [{ name: 'api', env: 'PORT' }] }],
      }],
    })
    const specs = buildServiceSpecs(f, runDir, 'local')
    expect(specs[0].env).toBeUndefined()
    expect(specs[0].allocatedPorts).toBeUndefined()
  })

  it('redirects cwd to the worktree override for an isolated repo', () => {
    const f = makeFeature({
      repos: [{ name: 'r', localPath: tmpDir, startCommands: [{ command: 'serve', name: 'svc' }] }],
    })
    const specs = buildServiceSpecs(f, runDir, 'local', { repoPathOverrides: { r: '/wt/r' } })
    expect(specs[0].cwd).toBe('/wt/r')
  })

  it('buildQueuedServiceEntries lists feature services with queued status, no ports/url', () => {
    const f = makeFeature({
      repos: [{
        name: 'r',
        localPath: tmpDir,
        startCommands: [{
          command: 'serve',
          name: 'svc',
          ports: [{ name: 'api', env: 'PORT' }],
          healthCheck: { http: { url: 'http://localhost:${port.api}/' } },
        }],
      }],
    })
    const entries = buildQueuedServiceEntries(f, runDir, 'local')
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      repoName: 'r',
      name: 'svc',
      safeName: 'svc',
      command: 'serve',
      status: 'queued',
    })
    // No port allocated yet, so the run-specific allocation + http URL are absent.
    expect(entries[0].allocatedPorts).toBeUndefined()
    expect(entries[0].healthUrl).toBeUndefined()
    expect(entries[0].logPath).toBe(buildRunPaths(runDir).serviceLog('svc'))
  })

  it('buildQueuedServiceEntries returns [] for a feature with no bootable services', () => {
    const f = makeFeature({ repos: [{ name: 'r', localPath: tmpDir }] })
    expect(buildQueuedServiceEntries(f, runDir, 'local')).toEqual([])
  })

  it('collectPortSlots gathers unique declared slots for the env', () => {
    const f = makeFeature({
      repos: [{
        name: 'r',
        localPath: tmpDir,
        startCommands: [
          { command: 'a', name: 'a', ports: [{ name: 'api', env: 'PORT' }] },
          { command: 'b', name: 'b', ports: [{ name: 'api' }, { name: 'admin', env: 'ADMIN_PORT' }] },
        ],
      }],
    })
    const slots = collectPortSlots(f, 'local')
    expect(slots.map((s) => s.name).sort()).toEqual(['admin', 'api'])
  })

  it('skips an entire repo when its repo-level envs excludes the selected env', () => {
    const f = makeFeature({
      repos: [
        {
          name: 'localOnly',
          localPath: tmpDir,
          envs: ['local'],
          startCommands: [{ command: 'a', name: 'apiA' }],
        },
        {
          name: 'always',
          localPath: tmpDir,
          startCommands: [{ command: 'b', name: 'apiB' }],
        },
      ],
    })
    const specs = buildServiceSpecs(f, runDir, 'production')
    expect(specs.map((s) => s.name)).toEqual(['apiB'])
  })
})
