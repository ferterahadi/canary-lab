import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  ROBUSTNESS_ENVELOPE_FORMAT,
  ROBUSTNESS_ENVELOPE_RELATIVE_PATH,
  defaultRobustnessEnvelope,
  parseRobustnessEnvelope,
  readRobustnessEnvelope,
  robustnessEnvelopePath,
  writeRobustnessEnvelope,
} from './envelope'
import type { RobustnessEnvelope } from './types'

let featureDir: string

beforeEach(() => {
  featureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-robustness-env-'))
})

afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(featureDir, { recursive: true, force: true })
})

const VALID: RobustnessEnvelope = {
  format: ROBUSTNESS_ENVELOPE_FORMAT,
  latency: { ms: 300 },
  duplicate: { gapMs: 500, match: 'WRITE /**' },
  restart: [{ slot: 'api', afterNth: 1, match: 'WRITE /**' }],
}

describe('robustnessEnvelopePath', () => {
  // The path sits inside features/<suite>/ so the D9 run-start snapshot copies
  // it and a mid-run edit is a spec edit — the whole reason it is not a field
  // in feature.config.cjs.
  it('lives under the suite folder at the one relative path every reader shares', () => {
    expect(ROBUSTNESS_ENVELOPE_RELATIVE_PATH).toBe('robustness/envelope.json')
    expect(robustnessEnvelopePath('/ws/features/storefront')).toBe(path.join('/ws/features/storefront', 'robustness', 'envelope.json'))
  })
})

describe('defaultRobustnessEnvelope', () => {
  it('perturbs every declared slot: fixed latency, one immediate duplicate of every write, one restart per slot held on its second write', () => {
    expect(defaultRobustnessEnvelope(['api', 'inventory'])).toEqual({
      format: ROBUSTNESS_ENVELOPE_FORMAT,
      latency: { ms: 300 },
      // Sent as the original is forwarded — a replay that lands after the
      // test's next read is invisible (the suite is faster than any gap).
      duplicate: { gapMs: 0, match: 'WRITE /**' },
      restart: [
        // Held on the second write: a restart before the first one has no
        // state to lose, so it would test nothing.
        { slot: 'api', afterNth: 2, match: 'WRITE /**' },
        { slot: 'inventory', afterNth: 2, match: 'WRITE /**' },
      ],
    })
  })

  it('declares no restart when there is no slot to restart', () => {
    expect(defaultRobustnessEnvelope([]).restart).toBeUndefined()
  })

  it('is itself a valid envelope', () => {
    const env = defaultRobustnessEnvelope(['api'])
    expect(parseRobustnessEnvelope(env)).toEqual({ ok: true, envelope: env })
  })
})

describe('parseRobustnessEnvelope', () => {
  it('accepts a complete envelope and an envelope with no atoms', () => {
    expect(parseRobustnessEnvelope(VALID)).toEqual({ ok: true, envelope: VALID })
    expect(parseRobustnessEnvelope({ format: ROBUSTNESS_ENVELOPE_FORMAT })).toEqual({ ok: true, envelope: { format: ROBUSTNESS_ENVELOPE_FORMAT } })
  })

  it('drops keys it does not know so a typo cannot ride along as a silent no-op atom', () => {
    const r = parseRobustnessEnvelope({ ...VALID, jitter: { ms: 5 } })
    expect(r).toEqual({ ok: true, envelope: VALID })
  })

  it('refuses a non-object and a wrong or missing format', () => {
    expect(parseRobustnessEnvelope(null)).toEqual({ ok: false, reason: 'envelope must be a JSON object' })
    expect(parseRobustnessEnvelope([])).toEqual({ ok: false, reason: 'envelope must be a JSON object' })
    expect(parseRobustnessEnvelope({})).toEqual({ ok: false, reason: `format must be "${ROBUSTNESS_ENVELOPE_FORMAT}"` })
    expect(parseRobustnessEnvelope({ format: 'x' })).toEqual({ ok: false, reason: `format must be "${ROBUSTNESS_ENVELOPE_FORMAT}"` })
  })

  // Shrink bisects these knobs, so each must be a whole number in a range the
  // shim can honour — a float or a negative would make the search meaningless.
  it('requires latency.ms to be a non-negative integer', () => {
    expect(parseRobustnessEnvelope({ format: ROBUSTNESS_ENVELOPE_FORMAT, latency: { ms: 0 } }).ok).toBe(true)
    expect(parseRobustnessEnvelope({ format: ROBUSTNESS_ENVELOPE_FORMAT, latency: { ms: -1 } })).toEqual({ ok: false, reason: 'latency.ms must be a non-negative integer' })
    expect(parseRobustnessEnvelope({ format: ROBUSTNESS_ENVELOPE_FORMAT, latency: { ms: 1.5 } })).toEqual({ ok: false, reason: 'latency.ms must be a non-negative integer' })
    expect(parseRobustnessEnvelope({ format: ROBUSTNESS_ENVELOPE_FORMAT, latency: 300 })).toEqual({ ok: false, reason: 'latency must be an object' })
  })

  it('requires duplicate.gapMs to be a non-negative integer and its match to parse', () => {
    expect(parseRobustnessEnvelope({ format: ROBUSTNESS_ENVELOPE_FORMAT, duplicate: { gapMs: -5, match: 'POST /x' } })).toEqual({ ok: false, reason: 'duplicate.gapMs must be a non-negative integer' })
    expect(parseRobustnessEnvelope({ format: ROBUSTNESS_ENVELOPE_FORMAT, duplicate: { gapMs: 5, match: 'POST' } })).toEqual({ ok: false, reason: 'duplicate.match: match must be "<METHOD> <path>", e.g. "POST /reserve"' })
    expect(parseRobustnessEnvelope({ format: ROBUSTNESS_ENVELOPE_FORMAT, duplicate: { gapMs: 5 } })).toEqual({ ok: false, reason: 'duplicate.match: match must be "<METHOD> <path>", e.g. "POST /reserve"' })
    expect(parseRobustnessEnvelope({ format: ROBUSTNESS_ENVELOPE_FORMAT, duplicate: 'yes' })).toEqual({ ok: false, reason: 'duplicate must be an object' })
  })

  it('requires restart to be a list of {slot, afterNth ≥ 1, match}', () => {
    expect(parseRobustnessEnvelope({ format: ROBUSTNESS_ENVELOPE_FORMAT, restart: { slot: 'api' } })).toEqual({ ok: false, reason: 'restart must be a list' })
    expect(parseRobustnessEnvelope({ format: ROBUSTNESS_ENVELOPE_FORMAT, restart: ['api'] })).toEqual({ ok: false, reason: 'restart[0] must be an object' })
    expect(parseRobustnessEnvelope({ format: ROBUSTNESS_ENVELOPE_FORMAT, restart: [{ slot: '', afterNth: 1, match: 'WRITE /**' }] })).toEqual({ ok: false, reason: 'restart[0].slot must be a non-empty string' })
    expect(parseRobustnessEnvelope({ format: ROBUSTNESS_ENVELOPE_FORMAT, restart: [{ slot: 'api', afterNth: 0, match: 'WRITE /**' }] })).toEqual({ ok: false, reason: 'restart[0].afterNth must be an integer ≥ 1' })
    expect(parseRobustnessEnvelope({ format: ROBUSTNESS_ENVELOPE_FORMAT, restart: [{ slot: 'api', afterNth: 1, match: 'nope' }] })).toEqual({ ok: false, reason: 'restart[0].match: match must be "<METHOD> <path>", e.g. "POST /reserve"' })
  })

  it('refuses two restarts on the same slot — the shim holds one restart schedule per slot', () => {
    expect(parseRobustnessEnvelope({
      format: ROBUSTNESS_ENVELOPE_FORMAT,
      restart: [{ slot: 'api', afterNth: 1, match: 'WRITE /**' }, { slot: 'api', afterNth: 2, match: 'WRITE /**' }],
    })).toEqual({ ok: false, reason: 'restart[1].slot "api" is declared twice' })
  })
})

describe('writeRobustnessEnvelope / readRobustnessEnvelope', () => {
  it('reads back what it wrote, creating the folder, with a trailing newline for clean diffs', () => {
    const written = writeRobustnessEnvelope(featureDir, VALID)
    expect(written).toBe(robustnessEnvelopePath(featureDir))
    expect(fs.readFileSync(written, 'utf8')).toBe(JSON.stringify(VALID, null, 2) + '\n')
    expect(readRobustnessEnvelope(featureDir)).toEqual({ kind: 'ok', path: written, envelope: VALID })
  })

  it('reports an absent file as absent, not as an error', () => {
    expect(readRobustnessEnvelope(featureDir)).toEqual({ kind: 'absent', path: robustnessEnvelopePath(featureDir) })
  })

  // A human owns this file in plain JSON (D15); a bad edit must be shown with
  // its reason, never treated as "no envelope".
  it('reports unparseable JSON and a schema violation as invalid with the reason', () => {
    const p = robustnessEnvelopePath(featureDir)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, '{ not json')
    const bad = readRobustnessEnvelope(featureDir)
    expect(bad.kind).toBe('invalid')
    expect(bad.kind === 'invalid' && bad.reason).toMatch(/JSON/)

    fs.writeFileSync(p, JSON.stringify({ format: ROBUSTNESS_ENVELOPE_FORMAT, latency: { ms: -1 } }))
    expect(readRobustnessEnvelope(featureDir)).toEqual({ kind: 'invalid', path: p, reason: 'latency.ms must be a non-negative integer' })
  })

  it('stringifies a non-Error throw rather than recording "undefined" as the reason', () => {
    writeRobustnessEnvelope(featureDir, VALID)
    vi.spyOn(fs, 'readFileSync').mockImplementation(() => { throw 'disk gone' })
    expect(readRobustnessEnvelope(featureDir)).toEqual({ kind: 'invalid', path: robustnessEnvelopePath(featureDir), reason: 'disk gone' })
  })

  it('reports an unreadable file (a directory in its place) as invalid, naming the I/O error', () => {
    fs.mkdirSync(robustnessEnvelopePath(featureDir), { recursive: true })
    const r = readRobustnessEnvelope(featureDir)
    expect(r.kind).toBe('invalid')
    expect(r.kind === 'invalid' && r.reason).toMatch(/EISDIR/)
  })
})
