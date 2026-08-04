import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MAX_DIFF_CHARS,
  bulletList,
  clipDiff,
  failureEvidenceSection,
  parseFixCommitMessage,
  writeFixCommitMessage,
} from './commit-message-agent'

const roots: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true })
})

function tmpPatch(body: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-msg-'))
  roots.push(root)
  const p = path.join(root, 'repo.patch')
  fs.writeFileSync(p, body)
  return p
}

const full = {
  commitSubject: 'fix(catalog): return 404 for unknown product ids',
  commitBody: 'The delete route was never implemented.',
  prTitle: 'Deleting a discontinued product now works',
  prBody: '## What changed\n- server.ts',
}

describe('parseFixCommitMessage', () => {
  it('reads the envelope out of prose around it', () => {
    const output = `Here is my answer:\n\n${JSON.stringify(full)}\n\nHope that helps.`
    expect(parseFixCommitMessage(output)).toEqual(full)
  })

  it('trims the fields', () => {
    const padded = { ...full, commitSubject: `  ${full.commitSubject}  `, prBody: `${full.prBody}\n\n` }
    expect(parseFixCommitMessage(JSON.stringify(padded))).toEqual(full)
  })

  it('rejects a half-filled envelope rather than putting an empty title on a PR', () => {
    // A blank prTitle would reach `gh pr create` verbatim — worse than the
    // deterministic template this replaces.
    expect(parseFixCommitMessage(JSON.stringify({ ...full, prTitle: '   ' }))).toBeNull()
    expect(parseFixCommitMessage(JSON.stringify({ ...full, prBody: '' }))).toBeNull()
    expect(parseFixCommitMessage(JSON.stringify({ ...full, commitBody: undefined }))).toBeNull()
  })

  it('skips a brace-bearing object that is not the answer', () => {
    const decoy = JSON.stringify({ note: 'thinking out loud' })
    expect(parseFixCommitMessage(`${decoy}\n${JSON.stringify(full)}`)).toEqual(full)
  })

  it('returns null on output carrying no JSON at all', () => {
    expect(parseFixCommitMessage('I could not read the diff.')).toBeNull()
    expect(parseFixCommitMessage('')).toBeNull()
  })

  it('ignores a non-object candidate', () => {
    expect(parseFixCommitMessage('[1, 2, 3]')).toBeNull()
  })
})

describe('clipDiff', () => {
  it('passes a normal repair through untouched', () => {
    const diff = 'diff --git a/x b/x\n+one line\n'
    expect(clipDiff(diff)).toBe(diff)
  })

  it('clips a runaway diff and says so, so nothing unseen gets described', () => {
    const clipped = clipDiff('x'.repeat(MAX_DIFF_CHARS + 500))
    expect(clipped.length).toBeLessThan(MAX_DIFF_CHARS + 300)
    expect(clipped).toContain('diff clipped')
  })
})

describe('failureEvidenceSection', () => {
  it('is empty when a healed run no longer lists failures', () => {
    // An empty heading would invite the agent to invent content under it.
    expect(failureEvidenceSection([])).toBe('')
  })

  it('names each failing test with its location and the head of its error', () => {
    const out = failureEvidenceSection([
      { name: 'deletes a product', location: 'e2e/catalog.spec.ts:31', error: { message: 'Expected 204\nReceived 405\nmore\nlines\nbeyond' } },
    ])
    expect(out).toContain('## Failing test evidence')
    expect(out).toContain('deletes a product')
    expect(out).toContain('e2e/catalog.spec.ts:31')
    expect(out).toContain('Expected 204')
    expect(out).not.toContain('beyond')
  })

  it('caps the list at ten failures', () => {
    const many = Array.from({ length: 14 }, (_, i) => ({ name: `t${i}` }))
    const out = failureEvidenceSection(many)
    expect(out).toContain('`t9`')
    expect(out).not.toContain('`t10`')
  })
})

describe('bulletList', () => {
  it('renders one backticked bullet per file', () => {
    expect(bulletList(['a.ts', 'b.ts'])).toBe('  - `a.ts`\n  - `b.ts`')
  })

  it('says so rather than emitting an empty list', () => {
    expect(bulletList([])).toBe('  - (not recorded)')
  })
})

describe('writeFixCommitMessage', () => {
  const input = {
    feature: 'demo_catalog',
    repoName: 'catalog_service',
    runId: 'r1',
    baseSha: 'abcdef1234567890',
    patchPath: '/nope/missing.patch',
  }

  it('returns null when the patch is gone, without spawning anything', async () => {
    expect(await writeFixCommitMessage(input)).toBeNull()
  })

  it('returns null on an empty patch', async () => {
    expect(await writeFixCommitMessage({ ...input, patchPath: tmpPatch('   \n') })).toBeNull()
  })
})
