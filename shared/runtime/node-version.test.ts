import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import {
  SUPPORTED_NODE_FLOORS,
  formatUnsupportedNode,
  isSupportedNode,
  nodeEnginesRange,
} from './node-version'

describe('node version floor', () => {
  it('matches the range package.json declares', () => {
    // The constant and `engines.node` are two statements of one requirement, and
    // only one of them is what npm reads. Pin them together so a future bump has
    // to move both or fail here.
    const pkg = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, '..', '..', 'package.json'), 'utf-8'),
    )
    expect(pkg.engines.node).toBe(nodeEnginesRange())
    expect(pkg.engines.node).toBe('>=22.23.4 <23.0.0 || >=24.22.1 <25.0.0 || >=26.12.1')
  })

  it('accepts each line from its patched release onward', () => {
    expect(isSupportedNode('22.23.4')).toBe(true)
    expect(isSupportedNode('v22.24.0')).toBe(true)
    expect(isSupportedNode('24.22.1')).toBe(true)
    expect(isSupportedNode('26.12.1')).toBe(true)
    expect(isSupportedNode('26.13.0')).toBe(true)
  })

  it('rejects each line before its HTTP2Shell fix', () => {
    // 24.0.0 is newer than the 22 floor and still unpatched — the reason this
    // is a floor per line rather than one global minimum.
    expect(isSupportedNode('22.23.3')).toBe(false)
    expect(isSupportedNode('22.12.0')).toBe(false)
    expect(isSupportedNode('24.0.0')).toBe(false)
    expect(isSupportedNode('24.22.0')).toBe(false)
    expect(isSupportedNode('26.12.0')).toBe(false)
  })

  it('rejects end-of-life lines that got no fix, and anything older', () => {
    expect(isSupportedNode('20.19.0')).toBe(false)
    expect(isSupportedNode('v23.11.0')).toBe(false)
    expect(isSupportedNode('25.9.0')).toBe(false)
  })

  it('accepts a line newer than the last one listed', () => {
    // Cut after the fix shipped, so it carries it.
    expect(isSupportedNode('27.0.0')).toBe(true)
  })

  it('passes an unreadable version rather than blocking on it', () => {
    // Fail-open is deliberate: refusing to start over a version string we could
    // not parse is a worse failure than the one this pre-empts.
    expect(isSupportedNode('not-a-version')).toBe(true)
  })

  it('names the running version, every floor, the reason, and the fix', () => {
    const msg = formatUnsupportedNode('22.12.0')
    expect(msg).toContain('this is Node 22.12.0')
    for (const floor of SUPPORTED_NODE_FLOORS) expect(msg).toContain(floor)
    expect(msg).toContain('CVE-2026-111497')
    expect(msg).toContain('nvm install 22')
  })

  it('reports floors the caller overrides', () => {
    expect(isSupportedNode('20.19.0', ['20.0.0'])).toBe(true)
    expect(nodeEnginesRange(['20.0.0', '22.1.0'])).toBe('>=20.0.0 <21.0.0 || >=22.1.0')
    expect(formatUnsupportedNode('18.0.0', ['20.0.0'])).toContain('needs Node 20.0.0, or a newer release')
  })
})
