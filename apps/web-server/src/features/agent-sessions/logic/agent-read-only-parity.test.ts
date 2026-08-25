import fs from 'fs'
import path from 'path'
import { describe, expect, it } from 'vitest'

// Read-only parity between the two agent arms.
//
// Three features spawn an agent whose whole job is to read and answer with
// JSON — a PRD summary, a coverage annotation set, a report rewrite. Each has
// always declared that on its codex arm with `--sandbox read-only`, while the
// claude arm right beside it got `--dangerously-skip-permissions` and nothing
// else. Same prompt, same cwd, full write access — and the agent resolver
// prefers claude, so the declared posture was the one that almost never ran.
//
// The claude arm now passes `readOnly: true` (an argv `--tools` allowlist, so
// the write tools are absent rather than merely discouraged). Nothing in the
// type system keeps the two arms in step: a new spawn, or a refactor that drops
// the flag, would silently re-open the gap. Hence this file.
//
// A feature that stops being read-only should be REMOVED from this list in the
// same change that grants it write access — deliberately, not by accident.

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..', '..')

const READ_ONLY_SPAWNS = [
  {
    what: 'coverage PRD summary',
    file: 'apps/web-server/src/features/coverage/logic/coverage/prd-summary.ts',
  },
  {
    what: 'coverage annotate',
    file: 'apps/web-server/src/features/coverage/logic/coverage/annotate-engine.ts',
  },
  {
    what: 'evaluation report rewrite',
    file: 'apps/web-server/src/features/evaluation/logic/test-review/rewrite-agent.ts',
  },
] as const

describe('read-only agent spawns keep both arms in step', () => {
  for (const { what, file } of READ_ONLY_SPAWNS) {
    const source = fs.readFileSync(path.join(REPO_ROOT, file), 'utf-8')

    it(`${what}: the codex arm still declares --sandbox read-only`, () => {
      expect(source).toMatch(/'--sandbox',\s*\n?\s*'read-only'|'--sandbox', 'read-only'/)
    })

    it(`${what}: the claude arm asks for the same posture`, () => {
      const call = source.match(/buildClaudeAgenticArgs\([\s\S]*?\)\n/)?.[0] ?? ''
      expect(call, `${file} builds claude args without readOnly`).toContain('readOnly: true')
    })
  }
})
