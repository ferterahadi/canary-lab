import { vi, describe, it, expect, beforeEach } from 'vitest'
import { EventEmitter } from 'events'
import path from 'path'
import { summarizePrd, renderPrdSummaryMarkdown, buildPrdSummaryPrompt, readPrdSummary, PRD_SUMMARY_JSON } from '../prd-summary'
import { computeDocsHash } from '../docs-collection'
import type { DocsCollection } from '../docs-collection'

export function collection(entries: { relPath: string; content: string }[]): DocsCollection {
  return { docsDir: '/tmp/docs', entries, docsHash: computeDocsHash(entries) }
}

export interface FakeChildOpts {
  stdout?: string
  stderr?: string
  exitCode?: number
  error?: Error
  delayMs?: number
}

export function makeFakeChild(opts: FakeChildOpts) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter
    stderr: EventEmitter
    stdin: { end: ReturnType<typeof vi.fn> }
    kill: ReturnType<typeof vi.fn>
  }
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.stdin = { end: vi.fn() }
  child.kill = vi.fn()
  const delay = opts.delayMs ?? 0
  setTimeout(() => {
    if (opts.stdout) child.stdout.emit('data', Buffer.from(opts.stdout))
    if (opts.stderr) child.stderr.emit('data', Buffer.from(opts.stderr))
    if (opts.error) {
      child.emit('error', opts.error)
    } else {
      child.emit('close', opts.exitCode ?? 0, null)
    }
  }, delay)
  return child
}

export const VALID_STDOUT = JSON.stringify({
  requirements: [
    { id: 'R1', title: 'Send message', text: 'A user can send a message', pathTypes: ['happy'] },
  ],
})

export const TEST_COLLECTION = collection([{ relPath: 'spec.md', content: '# Send message\nA user can send a message' }])
