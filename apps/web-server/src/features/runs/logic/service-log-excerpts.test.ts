import fs from 'fs'
import path from 'path'
import { describe, expect, it } from 'vitest'
import { trackTempDirs } from '../../../../../../tools/test-helpers/temp-dir'
import { buildRunPaths } from './runtime/run-paths'
import { EXCERPT_MAX_LINES, WINDOW_MAX_LINES, latestExecution, markerSpans, plainLogLines, serviceLogExcerpts, serviceLogFile, serviceLogLines } from './service-log-excerpts'

const runDir = trackTempDirs('svc-excerpt-')

function service(dir: string, safeName: string) {
  return { name: `${safeName} service`, safeName, command: 'x', cwd: dir, logPath: buildRunPaths(dir).serviceLog(safeName) }
}

function writeSegment(dir: string, safeName: string, execution: number, text: string): void {
  const file = buildRunPaths(dir).serviceLogSegment(safeName, execution)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}

const span = (name: string, body: string[]) => [`<${name}>`, ...body, `</${name}>`]

describe('plainLogLines', () => {
  it('keeps one display line per physical line, without control codes or redraws', () => {
    expect(plainLogLines('\u001b[32mready\u001b[0m\nprogress 10%\rprogress 100%\r\nsame\nsame\n')).toEqual(['ready', 'progress 100%', 'same', 'same'])
    expect(plainLogLines('no trailing newline')).toEqual(['no trailing newline'])
    // A blank line stays a line, so the numbering below it does not shift.
    expect(plainLogLines('a\n  \nb\n')).toEqual(['a', '', 'b'])
  })
})

describe('markerSpans', () => {
  it('finds every span in order, including output that shares a line with a tag', () => {
    const lines = ['boot', ...span('t', ['a', 'b']), 'between', 'tail<t>', 'c', 'last</t>', '<t>', 'still running']
    expect(markerSpans(lines, 't')).toEqual([
      { startLine: 3, endLine: 4, closed: true },
      { startLine: 8, endLine: 9, closed: true },
      { startLine: 11, endLine: 11, closed: false },
    ])
    expect(markerSpans(lines, 'other')).toEqual([])
  })
})

describe('serviceLogFile', () => {
  it('prefers an execution’s segment, uses the live log only for the latest, and admits a lost one', () => {
    const dir = runDir()
    const api = service(dir, 'api')
    writeSegment(dir, 'api', 1, 'one\n')
    fs.writeFileSync(api.logPath, 'live\n')
    expect(serviceLogFile(dir, api, 1, 2)?.source).toBe('segment')
    expect(serviceLogFile(dir, api, 2, 2)).toEqual({ source: 'live', file: api.logPath })
    expect(serviceLogFile(dir, api, 3, 4)).toBeUndefined()
    expect(serviceLogFile(dir, service(dir, 'never-wrote'), 2, 2)).toBeUndefined()
  })
})

describe('latestExecution', () => {
  it('reads the manifest count, or brackets a run recorded before executions were numbered', () => {
    const dir = runDir()
    expect(latestExecution(dir, { playwrightExecutions: 3 })).toBe(3)
    expect(latestExecution(dir, {})).toBe(0)
    const life = (phase: string, updatedAt: string) => JSON.stringify({ phase, headline: phase, updatedAt })
    fs.writeFileSync(buildRunPaths(dir).lifecycleEventsPath, [
      life('running-tests', '2026-01-01T00:00:00Z'), life('failed', '2026-01-01T00:01:00Z'),
      life('rerunning-tests', '2026-01-01T00:02:00Z'), life('completed', '2026-01-01T00:03:00Z'),
    ].join('\n') + '\n')
    expect(latestExecution(dir, {})).toBe(2)
  })
})

describe('serviceLogExcerpts', () => {
  it('answers each service with its span for the attempt, or why there is none', () => {
    const dir = runDir()
    const api = service(dir, 'api')
    const web = service(dir, 'web')
    const worker = service(dir, 'worker')
    writeSegment(dir, 'api', 1, [...span('t', ['first try']), ...span('t', ['retry: total=95'])].join('\n') + '\n')
    writeSegment(dir, 'web', 1, [...span('other', ['x'])].join('\n') + '\n')
    const excerpts = serviceLogExcerpts(dir, { services: [api, web, worker], playwrightExecutions: 2 }, 1, 't', { occurrence: 1, of: 2 })
    expect(excerpts).toEqual([
      {
        service: 'api', name: 'api service', execution: 1, source: 'segment', totalLines: 6,
        span: { startLine: 5, endLine: 5, closed: true }, matchedBy: 'order',
        window: { firstLine: 5, lines: ['retry: total=95'], truncated: false },
      },
      { service: 'web', name: 'web service', execution: 1, source: 'segment', totalLines: 3, missing: 'no-marker' },
      { service: 'worker', name: 'worker service', execution: 1, missing: 'not-retained' },
    ])
  })

  it('reads an execution’s spans from the end of a log that also holds earlier executions', () => {
    // A kept service's live log from a run recorded before every restart
    // rotated every log: execution 1's attempt and both of execution 2's sit
    // in one file, oldest first.
    const dir = runDir()
    const api = service(dir, 'api')
    fs.writeFileSync(api.logPath, [...span('t', ['exec 1']), ...span('t', ['exec 2 try']), ...span('t', ['exec 2 retry'])].join('\n') + '\n')
    const read = (occurrence: number) => serviceLogExcerpts(dir, { services: [api], playwrightExecutions: 2 }, 2, 't', { occurrence, of: 2 })[0]
    expect(read(0)).toMatchObject({ source: 'live', matchedBy: 'order', window: { lines: ['exec 2 try'] } })
    expect(read(1)).toMatchObject({ window: { lines: ['exec 2 retry'] } })
    // More attempts than spans: the earliest has none of its own to show.
    expect(serviceLogExcerpts(dir, { services: [api], playwrightExecutions: 2 }, 2, 't', { occurrence: 0, of: 4 })[0]).toMatchObject({ missing: 'no-marker' })
  })

  it('bounds a long span to its last lines and says it did', () => {
    const dir = runDir()
    const api = service(dir, 'api')
    const body = Array.from({ length: EXCERPT_MAX_LINES + 50 }, (_, i) => `line ${i + 1}`)
    fs.writeFileSync(api.logPath, span('t', body).join('\n') + '\n')
    const [excerpt] = serviceLogExcerpts(dir, { services: [api], playwrightExecutions: 1 }, 1, 't', { occurrence: 0, of: 1 })
    expect(excerpt.matchedBy).toBe('marker')
    expect(excerpt.window?.lines).toHaveLength(EXCERPT_MAX_LINES)
    expect(excerpt.window?.firstLine).toBe(52)
    expect(excerpt.window?.lines.at(-1)).toBe(`line ${EXCERPT_MAX_LINES + 50}`)
    expect(excerpt.window?.truncated).toBe(true)
  })
})

describe('serviceLogLines', () => {
  it('returns a bounded window, clamped to the file, and nothing for a lost execution', () => {
    const dir = runDir()
    const api = service(dir, 'api')
    fs.writeFileSync(api.logPath, Array.from({ length: 30 }, (_, i) => `l${i + 1}`).join('\n') + '\n')
    expect(serviceLogLines(dir, { playwrightExecutions: 1 }, api, 1, 28, 10)).toEqual({
      service: 'api', execution: 1, source: 'live', totalLines: 30, firstLine: 28, lines: ['l28', 'l29', 'l30'], truncated: false,
    })
    expect(serviceLogLines(dir, { playwrightExecutions: 1 }, api, 1, 99, 2)).toMatchObject({ firstLine: 30, lines: ['l30'] })
    expect(serviceLogLines(dir, { playwrightExecutions: 1 }, api, 1, 1, 5)).toMatchObject({ lines: ['l1', 'l2', 'l3', 'l4', 'l5'], truncated: true })
    expect(serviceLogLines(dir, { playwrightExecutions: 2 }, api, 1, 1, 5)).toBeUndefined()
  })

  it('never returns more than one window', () => {
    const dir = runDir()
    const api = service(dir, 'api')
    fs.writeFileSync(api.logPath, Array.from({ length: WINDOW_MAX_LINES + 5 }, () => 'x').join('\n'))
    expect(serviceLogLines(dir, { playwrightExecutions: 1 }, api, 1, 1, WINDOW_MAX_LINES * 2)?.lines).toHaveLength(WINDOW_MAX_LINES)
  })
})
