import { describe, expect, it } from 'vitest'
import { decode } from '@toon-format/toon'
import { encodeToonTable } from './toon'

describe('encodeToonTable', () => {
  it('emits the tabular form for a uniform primitive array', () => {
    const rows = [
      { runId: '7cvh', feature: 'checkout', status: 'passed' },
      { runId: 'a1b2', feature: 'login', status: 'failed' },
    ]
    expect(encodeToonTable(rows)).toBe(
      ['[2]{runId,feature,status}:', '  7cvh,checkout,passed', '  a1b2,login,failed'].join('\n'),
    )
  })

  it('fills missing optional keys with null to keep the table uniform', () => {
    const rows = [
      { id: 'r0001', name: 'a', extra: 'x' },
      { id: 'r0002', name: 'b' },
    ]
    expect(encodeToonTable(rows)).toBe(
      ['[2]{id,name,extra}:', '  r0001,a,x', '  r0002,b,null'].join('\n'),
    )
  })

  it('serializes stray nested values to compact JSON so rows stay tabular and lossless', () => {
    const rows = [
      { id: 'r0001', targets: { web: 'http://a' } },
      { id: 'r0002', targets: null },
    ]
    const out = encodeToonTable(rows)
    // The nested object survives as a JSON-string cell and round-trips back.
    const decoded = decode(out) as Array<{ id: string; targets: string | null }>
    expect(JSON.parse(decoded[0].targets as string)).toEqual({ web: 'http://a' })
    expect(decoded[1].targets).toBeNull()
  })

  it('preserves first-seen column order across rows', () => {
    const rows = [{ b: 1 }, { a: 2, b: 3 }]
    expect(encodeToonTable(rows)).toBe(['[2]{b,a}:', '  1,null', '  3,2'].join('\n'))
  })

  it('round-trips a realistic packed table through decode', () => {
    const rows = [
      { name: 'checkout', envs: 'dev|prod', repos: 'shop@/repos/shop@main' },
      { name: 'login', envs: 'dev', repos: 'shop@/repos/shop@main|api@/repos/api@dev' },
    ]
    expect(decode(encodeToonTable(rows))).toEqual(rows)
  })

  it('passes empty and non-array values through to compact JSON', () => {
    expect(encodeToonTable([])).toBe('[]')
    expect(encodeToonTable({ ok: true })).toBe('{"ok":true}')
  })
})
