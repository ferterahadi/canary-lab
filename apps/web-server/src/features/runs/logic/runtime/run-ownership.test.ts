import { describe, expect, it } from 'vitest'
import { HEARTBEAT_STALE_MS } from '../../../../../../../shared/run-state'
import { judgeRunOwnership, newHeartbeatOwner } from './run-ownership'

// Who drives a persisted unsettled run decides whether a server may settle it.
// The live incident: a server restarted inside the staleness window read its
// dead predecessor's healing run as "beating recently, so a live peer owns it"
// and left it healing forever with nothing driving it.

const NOW = Date.parse('2026-10-09T06:00:00.000Z')
const fresh = new Date(NOW - 5_000).toISOString()
const stale = new Date(NOW - HEARTBEAT_STALE_MS - 1_000).toISOString()
const self = { pid: 100, instanceId: 'self' }
const alive = (...pids: number[]) => (pid: number) => pids.includes(pid)

describe('judgeRunOwnership', () => {
  it('reads a row with no heartbeat, or a stale one, as gone whoever signed it', () => {
    expect(judgeRunOwnership({}, self, NOW, alive())).toBe('gone')
    expect(judgeRunOwnership({ heartbeatAt: stale, heartbeatOwner: { pid: 200, instanceId: 'peer' } }, self, NOW, alive(200))).toBe('gone')
  })

  it('keeps the freshness rule for an unsigned row: a recent beat could be a live peer', () => {
    expect(judgeRunOwnership({ heartbeatAt: fresh }, self, NOW, alive())).toBe('other-live-server')
  })

  it('recognises its own signature', () => {
    expect(judgeRunOwnership({ heartbeatAt: fresh, heartbeatOwner: self }, self, NOW, alive())).toBe('this-server')
  })

  it('reads its own pid under another instance id as its previous life, even though the pid is alive', () => {
    // A container restart can hand the new server the old one's pid.
    expect(judgeRunOwnership({ heartbeatAt: fresh, heartbeatOwner: { pid: 100, instanceId: 'before-restart' } }, self, NOW, alive(100))).toBe('gone')
  })

  it('settles the incident: a fresh beat signed by an exited server is gone, a live peer is not', () => {
    const peer = { heartbeatAt: fresh, heartbeatOwner: { pid: 200, instanceId: 'peer' } }
    expect(judgeRunOwnership(peer, self, NOW, alive())).toBe('gone')
    expect(judgeRunOwnership(peer, self, NOW, alive(200))).toBe('other-live-server')
  })
})

describe('newHeartbeatOwner', () => {
  it('signs with this pid and a fresh instance id per server', () => {
    const a = newHeartbeatOwner()
    const b = newHeartbeatOwner()
    expect(a.pid).toBe(process.pid)
    expect(a.instanceId).not.toBe(b.instanceId)
  })
})
