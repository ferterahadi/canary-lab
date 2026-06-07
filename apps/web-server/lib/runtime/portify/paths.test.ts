import { describe, expect, it } from 'vitest'
import path from 'path'
import { portifyRoot, portifyIndexPath, portifyDir, buildPortifyPaths } from './paths'

describe('portify paths', () => {
  it('derives the root, index, and per-workflow dir under <logs>/portify', () => {
    expect(portifyRoot('/logs')).toBe(path.join('/logs', 'portify'))
    expect(portifyIndexPath('/logs')).toBe(path.join('/logs', 'portify', 'index.json'))
    expect(portifyDir('/logs', 'portify-1')).toBe(path.join('/logs', 'portify', 'portify-1'))
  })

  it('builds the full path set for a workflow dir', () => {
    const dir = portifyDir('/logs', 'portify-1')
    const p = buildPortifyPaths(dir)
    expect(p).toEqual({
      dir,
      manifestPath: path.join(dir, 'portify.json'),
      agentLogPath: path.join(dir, 'agent.log'),
      verifyLogDir: path.join(dir, 'verify'),
      originalConfigPath: path.join(dir, 'original-config.snapshot'),
    })
  })
})
