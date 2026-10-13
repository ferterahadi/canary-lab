import fs from 'fs'
import path from 'path'

// Playwright's reporter objects are wide; these tests build only the fields the
// reporter reads, so the shapes stay `any` on purpose.

export function mkTest(title: string, file = '/spec.ts', line = 1): any {
  return { title, location: { file, line } }
}

export function mkResult(overrides: Partial<any> = {}): any {
  return { status: 'passed', duration: 42, retry: 0, ...overrides }
}

/** Readers over the artifacts the reporter writes into `logsDir`. */
export function summaryReaders(logsDir: string) {
  return {
    readSummary(): any {
      return JSON.parse(fs.readFileSync(path.join(logsDir, 'e2e-summary.json'), 'utf-8'))
    },
    readEvents(runDir = logsDir): any[] {
      return fs.readFileSync(path.join(runDir, 'playwright-events.jsonl'), 'utf-8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    },
  }
}
