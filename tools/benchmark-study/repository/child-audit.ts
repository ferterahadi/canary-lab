import fs from 'node:fs'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { codexConfigDir } from '../../../apps/web-server/src/features/agent-sessions/logic/agent-session-paths'
import { json, quote, readJson, sha, write } from '../files'
import { nativeSessionRecords, nativeChildMessageCalls } from '../attribution'
import type { Attempt, PolicyAdherence, StudyManifest, UsageAttribution } from '../types'
import { readRepositoryFailureContext } from './failure-context'
import { childReadGuard } from './child-read-guard'

export interface ChildAuditIdentity {
  authFile: string; accountIdentitySha256: string
  backend?: 'local-v1'; catalogFile?: string; catalogModel?: string; catalogModelSha256?: string
}

function catalogModel(file: string, model: string) {
  const entry = readJson<{ models: Array<Record<string, unknown>> }>(file).models.find((entry) => entry.slug === model)
  if (!entry) throw new Error('Pinned Codex model is absent from its native catalog')
  return entry
}

export function childAuditIdentity(model: string): ChildAuditIdentity {
  const authFile = fs.realpathSync(path.join(codexConfigDir(), 'auth.json'))
  const auth = readJson<{ auth_mode: string; tokens?: { account_id?: string } }>(authFile)
  if (auth.auth_mode !== 'chatgpt' || !auth.tokens?.account_id) throw new Error('Child audit requires the existing Codex ChatGPT file login')
  const catalogFile = fs.realpathSync(path.join(codexConfigDir(), 'models_cache.json'))
  return { authFile, accountIdentitySha256: sha(auth.tokens.account_id), backend: 'local-v1', catalogFile,
    catalogModel: model, catalogModelSha256: sha(JSON.stringify(catalogModel(catalogFile, model))) }
}

export function verifyChildAuditIdentity(identity: ChildAuditIdentity): void {
  const auth = readJson<{ auth_mode: string; tokens?: { account_id?: string } }>(identity.authFile)
  if (auth.auth_mode !== 'chatgpt' || !auth.tokens?.account_id || sha(auth.tokens.account_id) !== identity.accountIdentitySha256) {
    throw new Error('Codex audit authentication identity changed')
  }
  if (process.env.OPENAI_API_KEY || process.env.OPENAI_BASE_URL || process.env.CODEX_MODEL_PROVIDER || process.env.CODEX_CHATGPT_BASE_URL) {
    throw new Error('Codex audit does not permit provider-routing environment overrides')
  }
  if (identity.backend === 'local-v1' && (!identity.catalogFile || !identity.catalogModel ||
      sha(JSON.stringify(catalogModel(identity.catalogFile, identity.catalogModel))) !== identity.catalogModelSha256)) {
    throw new Error('Pinned native Codex catalog metadata changed')
  }
}

export function prepareChildAudit(manifest: StudyManifest, attempt: Attempt, root: string) {
  const identity = manifest.repository?.childAudit
  if (!identity) throw new Error('Repository campaign lacks frozen child audit configuration')
  verifyChildAuditIdentity(identity)
  const home = path.join(manifest.root, 'native/codex-audit', attempt.id)
  const output = path.join(manifest.root, 'audit', attempt.id, 'tool-inputs.jsonl')
  const script = path.join(manifest.root, 'frozen/audit/child-audit-hook.cjs')
  fs.mkdirSync(home, { recursive: true })
  if (!fs.existsSync(path.join(home, 'auth.json'))) fs.symlinkSync(identity.authFile, path.join(home, 'auth.json'))
  const command = [process.execPath, script, output, root].map(quote).join(' ')
  const handler = { type: 'command', command, timeout: 5 }
  const matcher = '^(?:(?:collaboration|multi_agent_v1|functions)[._]*)?(?:spawn_agent|Agent|send_message|followup_task|send_input)$'
  const guard = childReadGuard(manifest, attempt, root)
  const hooks = { SessionStart: [{ hooks: [handler] }], SubagentStart: guard.hooks.SubagentStart,
    PreToolUse: [{ matcher, hooks: [handler] }, ...guard.hooks.PreToolUse], PostToolUse: [{ matcher, hooks: [handler] }] }
  // An isolated home prevents merging and executing unrelated user/project
  // hooks. Authentication is referenced, never copied into evidence snapshots.
  // V2 encrypts task messages before the hook boundary. V1's local tasks
  // preserve readable assignments and the same frozen model/effort pins.
  const catalog = path.join(manifest.root, 'frozen/audit/model-catalog.json')
  const config = 'model_provider = "openai"\nforced_login_method = "chatgpt"\ncli_auth_credentials_store = "file"\nproject_doc_max_bytes = 0\n' +
    (identity.backend === 'local-v1' ? `model_catalog_json = ${JSON.stringify(catalog)}\n` : '') +
    '[features]\nhooks = true\napps = false\nplugins = false\nmemories = false\n' +
    (identity.backend === 'local-v1' ? 'multi_agent_v2 = false\n' : '')
  write(path.join(home, 'config.toml'), config)
  json(path.join(home, 'hooks.json'), { hooks })
  json(path.join(manifest.root, 'audit', attempt.id, 'runtime-profile.json'), { home, output, script,
    configSha256: sha(config), hooksSha256: sha(fs.readFileSync(path.join(home, 'hooks.json'))),
    scriptSha256: sha(fs.readFileSync(script)), childReadGuardSha256: guard.scriptSha256, accountIdentitySha256: identity.accountIdentitySha256,
    authReference: identity.authFile, inheritedHooks: 'excluded by isolated home; project trust absent',
    trust: 'documented one-invocation bypass for this vetted hook only', provider: 'openai', credentialsCopied: false,
    backend: identity.backend ?? 'model-default', ...(identity.backend ? { catalogSha256: sha(fs.readFileSync(catalog)) } : {}) })
  // The isolated home has no inherited MCP definitions. Applying only an
  // enabled=false field would manufacture an invalid transport-less server.
  const args = (manifest.codexToolArgs ?? []).filter((value, index, all) =>
    !(value === '--disable' && all[index + 1] === 'hooks' || value === 'hooks' && all[index - 1] === '--disable' ||
      value === '-c' && /^mcp_servers\.[A-Za-z0-9_-]+\.enabled=false$/.test(all[index + 1] ?? '') ||
      /^mcp_servers\.[A-Za-z0-9_-]+\.enabled=false$/.test(value) && all[index - 1] === '-c'))
  return { home, output, args: [...args, '--dangerously-bypass-hook-trust'] }
}

export function freezeChildAudit(root: string, identity?: ChildAuditIdentity): void {
  write(path.join(root, 'frozen/audit/child-audit-hook.cjs'), fs.readFileSync(path.join(__dirname, 'child-audit-hook.cjs'), 'utf8'))
  if (identity?.backend === 'local-v1') {
    const original = catalogModel(identity.catalogFile!, identity.catalogModel!)
    json(path.join(root, 'frozen/audit/original-model.json'), original)
    json(path.join(root, 'frozen/audit/model-catalog.json'), { models: [{ ...original, multi_agent_version: 'v1' }] })
  }
}

export function reviewChildAudit(manifest: StudyManifest, attempt: Attempt, root: string,
  attribution: UsageAttribution, adherence: PolicyAdherence): PolicyAdherence {
  const output = path.join(manifest.root, 'audit', attempt.id, 'tool-inputs.jsonl')
  const events = fs.existsSync(output) ? nativeSessionRecords(fs.readFileSync(output, 'utf8')) : []
  const violations: string[] = []
  const comparisons: Array<{ callId: string; failureId: string; match: string; actualSha256: string; expectedSha256: string }> = []
  if (!events.some((event) => event.hook_event_name === 'SessionStart')) violations.push('Native audit hook readiness was not captured')
  const failures = readRepositoryFailureContext(root)
  const calls = attribution.sessions.flatMap((session) => nativeChildMessageCalls(fs.readFileSync(path.join(root, session.evidence, 'session.jsonl'), 'utf8'))
    .map((call) => ({ sessionId: session.sessionId, role: session.role, ...call })))
  for (const event of events.filter((event) => event.hook_event_name === 'PreToolUse')) {
    if (!calls.some((call) => call.call_id === event.tool_use_id && call.sessionId === event.session_id)) {
      violations.push(`Audited child call absent from native session: ${event.tool_use_id}`)
    }
  }
  for (const call of calls) {
    const pre = events.filter((event) => event.hook_event_name === 'PreToolUse' && event.tool_use_id === call.call_id)
    const post = events.filter((event) => event.hook_event_name === 'PostToolUse' && event.tool_use_id === call.call_id)
    if (pre.length !== 1 || post.length !== 1) { violations.push(`Missing or ambiguous native hook pair: ${call.call_id}`); continue }
    const input = pre[0].tool_input
    if (pre[0].session_id !== call.sessionId || post[0].session_id !== call.sessionId || !isDeepStrictEqual(input, post[0].tool_input)) {
      violations.push(`Native hook phases differ in session or inputs: ${call.call_id}`)
    }
    if (call.prompt !== undefined && (call.prompt !== input?.message || call.name.endsWith('spawn_agent') &&
        (call.model !== input.model || call.reasoning_effort !== input.reasoning_effort))) {
      violations.push(`Native collaboration event differs from audited input: ${call.call_id}`)
    }

    if (typeof input?.message !== 'string' || input.message.startsWith('gAAAA')) { violations.push(`Unreadable native child message: ${call.call_id}`); continue }
    if (call.name.endsWith('spawn_agent')) {
      const found = failures.find((failure) => fs.readFileSync(path.join(root, failure.childPromptPath), 'utf8').trimEnd() === input.message.trimEnd())
      if (!found) { violations.push(`Child launch did not contain a single frozen handoff: ${call.call_id}`); continue }
      const expected = fs.readFileSync(path.join(root, found.childPromptPath), 'utf8')
      comparisons.push({ callId: call.call_id, failureId: found.failureId, match: expected === input.message ? 'exact' : 'trailing-whitespace-only',
        actualSha256: sha(input.message), expectedSha256: sha(expected) })
      const fresh = manifest.repository?.childAudit?.backend === 'local-v1' ? input.fork_context === false : input.fork_turns === 'none'
      if (!fresh || input.model !== manifest.pins.codex.model || input.reasoning_effort !== manifest.pins.codex.effort) {
        violations.push(`Audited child history/model pins differ: ${call.call_id}`)
      }
    }
  }
  if (attempt.variant?.diagnosisPolicy === 'per-failure' && new Set(comparisons.map((entry) => entry.failureId)).size !== failures.length) {
    violations.push('Audited handoffs do not cover every failure')
  }
  json(path.join(root, 'child-assignment-review.json'), { events: events.length, nativeMessageCalls: calls.length, comparisons, violations,
    followupSemanticReviewRequired: calls.some((call) => !call.name.endsWith('spawn_agent')), readOnlyReviewRequired: true })
  return violations.length ? { ...adherence, status: 'violation', evidence: [...adherence.evidence, ...violations] } :
    { ...adherence, evidence: [...adherence.evidence, 'Actual native child messages retained by protected Pre/PostToolUse hooks; handoffs compared with frozen packets.'] }
}
