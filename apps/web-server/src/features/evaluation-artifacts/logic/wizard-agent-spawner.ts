import fs from 'fs'
import path from 'path'
import { modelArgs } from '../../agent-management/logic/agent-models'
import { locateCodexSessionLog } from '../../agent-management/logic/agent-session-log'
import { buildClaudeAgenticArgs } from '../../agent-management/logic/agent-process'

// Pure helpers for the Add Test wizard's plan / spec agents:
//
//   - Template loading + `{{placeholder}}` substitution
//   - Repo / plan formatters that turn structured input into the
//     plain-text the prompt template embeds
//   - The tee-to-disk reducer that fans pty output into a log file + an
//     optional PaneBroker
//   - Shell quoting + claude argv construction for `claude -p <prompt>`
//
// All side effects are scoped to fs + an optional PaneBroker. The pty driver
// itself lives in `wizard-agent-runner.ts` (excluded from coverage) and
// composes these helpers.

export const PROMPTS_DIR = path.resolve(__dirname, '..', '..', '..', '..', 'prompts')

export const STAGE1_TEMPLATE = path.join(PROMPTS_DIR, 'stage1-plan.md')
export const STAGE1_DIFF_TEMPLATE = path.join(PROMPTS_DIR, 'stage1-diff-plan.md')
export const STAGE2_TEMPLATE = path.join(PROMPTS_DIR, 'stage2-spec.md')

export type WizardAgentStage = 'planning' | 'generating'
export type WizardAgentKind = 'claude' | 'codex'

export function loadTemplate(file: string): string {
  return fs.readFileSync(file, 'utf8')
}

// Substitute `{{name}}` placeholders. Unknown placeholders are left as-is
// (the agent will see them as `{{whatever}}` in the prompt — harmless).
export function substitute(
  template: string,
  vars: Record<string, string>,
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
    return Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : match
  })
}

export interface RepoSummary {
  name: string
  localPath: string
  branch?: string
}

export function formatRepos(repos: RepoSummary[]): string {
  if (repos.length === 0) return '(none)'
  return repos
    .map((r) => `- ${r.name} (${r.localPath})${r.branch ? ` branch=${r.branch}` : ''}`)
    .join('\n')
}

export function formatPlan(plan: unknown): string {
  return JSON.stringify(plan, null, 2)
}

export function buildPlanPrompt(input: {
  prdText: string
  repos: RepoSummary[]
  template?: string
}): string {
  const template = input.template ?? loadTemplate(STAGE1_TEMPLATE)
  return substitute(template, {
    prdText: input.prdText,
    repos: formatRepos(input.repos),
  })
}

export function buildSpecPrompt(input: {
  featureName: string
  plan: unknown
  repos: RepoSummary[]
  template?: string
}): string {
  const template = input.template ?? loadTemplate(STAGE2_TEMPLATE)
  return substitute(template, {
    featureName: input.featureName,
    plan: formatPlan(input.plan),
    repos: formatRepos(input.repos),
  })
}

// Tee reducer: every chunk the headless agent writes to stdout/stderr is
// appended to `logPath` and accumulated. The route parses the accumulated
// stream once the agent exits (the live view is the JSONL tail, not this log).
//
// Kept synchronous (`appendFileSync`) because chunks are small and the
// alternative — async writes — opens up out-of-order writes and lost output
// if the process exits before the queue drains.
export interface TeeSink {
  push(chunk: string): void
  fullStream(): string
}

export function createTeeSink(opts: { logPath: string }): TeeSink {
  // Ensure the log directory exists & file is truncated for this run.
  fs.mkdirSync(path.dirname(opts.logPath), { recursive: true })
  fs.writeFileSync(opts.logPath, '', 'utf8')
  let acc = ''
  return {
    push(chunk: string): void {
      acc += chunk
      try {
        fs.appendFileSync(opts.logPath, chunk, 'utf8')
      } catch {
        // The agent log is best-effort — losing a chunk to disk should not
        // fail the run. The accumulated `acc` is the source of truth for
        // downstream parsers.
      }
    },
    fullStream(): string {
      return acc
    },
  }
}

// Headless agentic argv — the Portify model. No formatter pipe, no stream-json:
// the agent uses its tools and writes a session JSONL (the live timeline that
// AgentSessionView tails); its final stdout message carries the parseable output.
// `pinSessionId` (claude) fixes the JSONL path so the tail can attach from spawn;
// codex has no pinned id and is located later by cwd + start.
export function buildWizardArgs(
  agent: WizardAgentKind,
  prompt: string,
  opts: { resumeSessionId?: string; pinSessionId?: string; model?: string | null } = {},
): string[] {
  if (agent === 'claude') {
    // Shared claude agentic argv (stream-json for liveness + answer recovery;
    // display = JSONL tail). spec stage resumes the plan session; plan pins one.
    return buildClaudeAgenticArgs(prompt, {
      model: opts.model,
      sessionId: opts.resumeSessionId ?? opts.pinSessionId,
      resume: Boolean(opts.resumeSessionId),
    })
  }
  if (opts.resumeSessionId) {
    return ['exec', 'resume', '--skip-git-repo-check', '--full-auto', ...modelArgs(opts.model ?? null), opts.resumeSessionId, prompt]
  }
  return ['exec', '--skip-git-repo-check', '--full-auto', ...modelArgs(opts.model ?? null), prompt]
}

// The agent's persisted session id for the spec stage to `--resume`. claude's is
// the id we pinned; codex's is discovered from its session log by cwd + spawn time
// (replaces the old formatter SESSION_MARKER parse).
export function resolveWizardSessionId(opts: {
  agent: WizardAgentKind
  cwd: string
  pinSessionId?: string
  spawnedAt: string
}): { kind: WizardAgentKind; id: string } | null {
  if (opts.agent === 'claude') {
    return opts.pinSessionId ? { kind: 'claude', id: opts.pinSessionId } : null
  }
  const ref = locateCodexSessionLog(opts.cwd, opts.spawnedAt)
  return ref ? { kind: 'codex', id: ref.sessionId } : null
}
