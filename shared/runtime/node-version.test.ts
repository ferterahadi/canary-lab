import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import {
  MINIMUM_NODE_VERSION,
  formatUnsupportedNode,
  meetsMinimumNode,
} from './node-version'

describe('node version floor', () => {
  it('matches the floor package.json declares', () => {
    // The constant and `engines.node` are two statements of one requirement, and
    // only one of them is what npm reads. Pin them together so a future bump has
    // to move both or fail here.
    const pkg = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, '..', '..', 'package.json'), 'utf-8'),
    )
    expect(pkg.engines.node).toBe(`>=${MINIMUM_NODE_VERSION}`)
  })

  it('accepts the floor and anything newer', () => {
    expect(meetsMinimumNode('22.12.0')).toBe(true)
    expect(meetsMinimumNode('22.12.1')).toBe(true)
    expect(meetsMinimumNode('24.3.0')).toBe(true)
    expect(meetsMinimumNode('v23.0.0')).toBe(true)
  })

  it('rejects the versions 1.5.1 supported', () => {
    // The exact upgrade this guard exists for: `engines` moved 20.19 -> 22.12,
    // and npm let both of these install anyway.
    expect(meetsMinimumNode('20.19.0')).toBe(false)
    expect(meetsMinimumNode('22.11.0')).toBe(false)
  })

  it('passes an unreadable version rather than blocking on it', () => {
    // Fail-open is deliberate: refusing to start over a version string we could
    // not parse is a worse failure than the one this pre-empts.
    expect(meetsMinimumNode('not-a-version')).toBe(true)
  })

  it('names the running version, the floor, and the fix', () => {
    const msg = formatUnsupportedNode('20.19.0')
    expect(msg).toContain('20.19.0')
    expect(msg).toContain(MINIMUM_NODE_VERSION)
    expect(msg).toContain('nvm install 22')
  })

  it('reports a floor the caller overrides', () => {
    expect(meetsMinimumNode('20.19.0', '20.0.0')).toBe(true)
    expect(formatUnsupportedNode('18.0.0', '20.0.0')).toContain('Node 20.0.0 or newer')
  })
})
