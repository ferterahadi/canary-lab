import fs from 'fs'
import path from 'path'
import type { TestResult, TestStep } from '@playwright/test/reporter'
import { getSummaryPath } from './paths'
import { RunningStep, TestEntry, slugify } from './summary-reporter'

export function isFailureResult(entry: Pick<TestEntry, 'status'>): boolean {
  return entry.status !== 'passed' && entry.status !== 'skipped'
}

// Playwright records the trace zip as an attachment with `name === 'trace'`
// and a `path` pointing at the per-test artifact dir
// (`<playwright-artifacts>/<pw-slug>/trace.zip`). The slug Playwright uses
// here is its own and doesn't match our `slugify(title)`, so we read the
// path off the attachment directly instead of reconstructing it.
export function findTraceAttachmentPath(
  attachments: ReadonlyArray<{ name?: string; path?: string }> | undefined,
): string | null {
  return findAttachmentPath(attachments, 'trace')
}

// One finder for every attachment the run leaves behind. Attachments are how
// per-test evidence reaches the reporter: some are Playwright's own
// (`trace`, `error-context`), some are ours (`canary-lab-network-har`, written
// by the published log-marker fixture).
export function findAttachmentPath(
  attachments: ReadonlyArray<{ name?: string; path?: string }> | undefined,
  attachmentName: string,
): string | null {
  if (!attachments) return null
  for (const a of attachments) {
    if (a?.name === attachmentName && typeof a.path === 'string' && a.path.length > 0) {
      return a.path
    }
  }
  return null
}

// Playwright attaches a Markdown `error-context` file to a failed test — the
// page state at the moment of failure, built from the same data its
// `TestInfoError.errorContext` carries. That property is only visible inside
// the test process, but the attachment reaches the reporter, so this is how we
// read it without asking features to change their specs.
export function findErrorContextAttachmentPath(
  attachments: ReadonlyArray<{ name?: string; path?: string }> | undefined,
): string | null {
  return findAttachmentPath(attachments, 'error-context')
}

// The per-test HAR our published fixture records and keeps only on failure.
export function findHarAttachmentPath(
  attachments: ReadonlyArray<{ name?: string; path?: string }> | undefined,
): string | null {
  return findAttachmentPath(attachments, 'canary-lab-network-har')
}

export function journalPathForSummary(): string {
  return path.join(path.dirname(getSummaryPath()), 'diagnosis-journal.md')
}

export function runIdForSummary(): string | undefined {
  const manifestPath = process.env.CANARY_LAB_MANIFEST_PATH
    ?? path.join(path.dirname(getSummaryPath()), 'manifest.json')
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as { runId?: unknown }
    return typeof parsed.runId === 'string' ? parsed.runId : undefined
  } catch {
    return undefined
  }
}

export function isErrorShape(value: unknown): value is { message: string; snippet?: string } {
  if (!value || typeof value !== 'object') return false
  const err = value as { message?: unknown; snippet?: unknown }
  return typeof err.message === 'string' && (err.snippet === undefined || typeof err.snippet === 'string')
}

export function stepToRunningStep(step: TestStep): RunningStep {
  const locations = stepLocationChain(step)
  return {
    title: step.title,
    category: step.category,
    ...(step.location ? { location: `${step.location.file}:${step.location.line}` } : {}),
    ...(locations.length > 0 ? { locations } : {}),
  }
}

export function failureLocations(result: TestResult, failedStepLocations?: string[]): string[] {
  const out: string[] = []
  const add = (location: string) => {
    const normalized = normalizeLocation(location)
    if (out.includes(normalized)) return
    out.push(normalized)
  }
  const addLocation = (location: { file: string; line: number } | undefined) => {
    if (!location) return
    add(`${location.file}:${location.line}`)
  }

  addLocation(result.error?.location)
  for (const error of result.errors ?? []) {
    addLocation(error.location)
    for (const location of stackLocations(error.stack)) add(location)
  }
  for (const location of failedStepLocations ?? []) add(location)
  return out
}

export function stackLocations(stack: string | undefined): string[] {
  if (!stack) return []
  const out: string[] = []
  const locationRe = /(?:\(|\s)(\/[^():\n]+:\d+(?::\d+)?)(?:\)|\s|$)/g
  for (const match of stack.matchAll(locationRe)) {
    const location = match[1]
    if (!out.includes(location)) out.push(location)
  }
  return out
}

export function normalizeLocation(location: string): string {
  const match = location.match(/^(\/[^:\n]+:\d+)(?::\d+)?$/)
  return match ? match[1] : location
}

export function stepLocationChain(step: TestStep): string[] {
  const chain: string[] = []
  let cur: TestStep | undefined = step
  while (cur) {
    if (cur.location) chain.push(`${cur.location.file}:${cur.location.line}`)
    cur = cur.parent
  }
  return chain
}

export function findLastStepIndex(steps: RunningStep[], target: RunningStep): number {
  for (let i = steps.length - 1; i >= 0; i--) {
    const s = steps[i]
    if (
      s.title === target.title &&
      s.category === target.category &&
      s.location === target.location
    ) {
      return i
    }
  }
  return -1
}
