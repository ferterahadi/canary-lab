import { banner, section, ok, fail, info, dim, line } from '../shared/cli-ui/ui'
import { runAsScript } from './run-as-script'
import { getProjectRoot } from '../shared/runtime/project-root'
import { DEFAULT_PORT, loadProjectConfig, resolveProjectPort } from '../apps/web-server/src/features/runs/logic/runtime/launcher/project-config'

// The boot command is a thin client over the same REST surface the web UI uses,
// so it requires `canary-lab ui` to be running. The port comes from this
// project's canary-lab.config.json (default 7421).
function resolveServerBase(): string {
  try {
    return `http://localhost:${resolveProjectPort(loadProjectConfig(getProjectRoot()))}`
  } catch {
    return `http://localhost:${DEFAULT_PORT}`
  }
}
const SERVER = resolveServerBase()

function usage(): void {
  banner('Canary Lab — boot')
  section('Usage')
  console.log(`  canary-lab boot <feature> ${dim('[env]')}      ${dim('# apply envset + boot services, hold (no tests)')}`)
  console.log(`  canary-lab boot stop <runId>        ${dim('# stop services + revert envset')}`)
  line()
  info('Requires a running server — start it with `npx canary-lab ui` first.')
}

async function postJson(url: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  let resp: Response
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch {
    fail(`Could not reach the Canary Lab server at ${SERVER}. Start it with \`npx canary-lab ui\`, then retry.`)
    process.exit(1)
  }
  const json = (await resp.json().catch(() => ({}))) as Record<string, unknown>
  return { status: resp.status, json }
}

async function boot(feature: string, env?: string): Promise<void> {
  const { status, json } = await postJson(`${SERVER}/api/runs`, {
    feature,
    ...(env ? { env } : {}),
    mode: 'boot',
  })
  if (status === 201 || status === 200) {
    const runId = String(json.runId)
    ok(`Booting "${feature}"${env ? ` (${env})` : ''} — services will come up and be held.`)
    info(`Run ${dim(runId)} — open ${dim(`${SERVER}`)} to see service URLs, logs, and Stop.`)
    info(`Tear down with: ${dim(`canary-lab boot stop ${runId}`)}`)
    return
  }
  if (status === 202) {
    ok(`Boot queued (runId ${String(json.runId)}, reason: ${String(json.queueReason ?? 'resources')}).`)
    info('It will start automatically when capacity frees. Stop it any time with `canary-lab boot stop <runId>`.')
    return
  }
  if (status === 409 && json.type === 'repo_collision_requires_choice') {
    fail(`Another run (${String(json.conflictingFeature)}) is using the same app.`)
    info('Resolve the worktree/queue choice from the web UI or the MCP `boot_services` tool (isolation: "worktree" | "queue").')
    process.exit(1)
  }
  fail(`Boot failed (${status}): ${String(json.error ?? 'unknown error')}`)
  process.exit(1)
}

async function stop(runId: string): Promise<void> {
  const { status, json } = await postJson(`${SERVER}/api/runs/${encodeURIComponent(runId)}/abort`, {})
  if (status >= 200 && status < 300) {
    ok(`Stopped ${dim(runId)} — services torn down and envset reverted.`)
    return
  }
  fail(`Stop failed (${status}): ${String(json.error ?? 'run not active or not found')}`)
  process.exit(1)
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const [first, second] = args
  if (!first || first === '-h' || first === '--help') {
    usage()
    return
  }
  if (first === 'stop') {
    if (!second) {
      fail('Usage: canary-lab boot stop <runId>')
      process.exit(1)
    }
    await stop(second)
    return
  }
  // `boot <feature> [env]`
  await boot(first, second)
}

runAsScript(module, () => main())
