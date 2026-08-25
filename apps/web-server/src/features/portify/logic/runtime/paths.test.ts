import { describe, expect, it } from 'vitest'
import path from 'path'
import { portifyRoot, portifyIndexPath, portifyDir, buildPortifyPaths } from './paths'

describe('portify paths', () => {
  it('derives the root, index, and per-workflow dir under <logs>/portify', () => {
    expect(portifyRoot('/logs')).toBe(path.join('/logs', 'portify'))
    expect(portifyIndexPath('/logs')).toBe(path.join('/logs', 'portify', 'index.json'))
    expect(portifyDir('/logs', 'portify-1')).toBe(path.join('/logs', 'portify', 'portify-1'))
  })

  // `toEqual` on the whole set is deliberate: every file the workflow dir owns
  // has to be reachable from one place, so a NEW path landing in
  // buildPortifyPaths without a test is itself the failure. Adding a field here
  // is the intended cost of adding one there.
  it('builds the full path set for a workflow dir', () => {
    const dir = portifyDir('/logs', 'portify-1')
    const p = buildPortifyPaths(dir)
    expect(p).toEqual({
      dir,
      manifestPath: path.join(dir, 'portify.json'),
      agentLogPath: path.join(dir, 'agent.log'),
      verifyLogDir: path.join(dir, 'verify'),
      originalConfigPath: path.join(dir, 'original-config.snapshot'),
      // Restart-proofs a parked `ready-to-save` review — see PortifyPaths.
      pendingOverlayPath: path.join(dir, 'pending-overlay.json'),
    })
  })
})
