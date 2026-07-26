import fs from 'fs'
import {
  registerCanaryLabMcp,
  registeredCliPath,
  type McpRegistrationTarget,
} from './mcp-registration'
import {
  registerClaudeDesktopMcp,
  claudeDesktopConfigPath,
  claudeDesktopInstalled,
} from './desktop-registration'

export interface RefreshOptions {
  log?: (msg: string) => void
  homeDir?: string
  execPath?: string
  cliPath?: string
  /** Override the Claude Desktop config path (testing). */
  claudeDesktopConfigPath?: string
}

// Re-point already-configured MCP clients at the current install. Used on
// `canary-lab upgrade` so a legacy `npx -y canary-lab mcp` entry or a stale
// absolute path self-heals. Never adds canary-lab to a client that was not
// already configured (first-time setup stays explicit via `canary-lab setup`).
export function refreshCanaryLabMcp(opts: RefreshOptions = {}): void {
  // Same guard as `setup` (see setup.ts): the tarball smoke test runs
  // `upgrade` (which calls this) inside a throwaway temp install, and these
  // refreshes write to the real ~/.claude.json / ~/.codex / Desktop configs.
  // Skip so a smoke run never re-points a developer's live client at a temp path.
  if (process.env.CANARY_LAB_SKIP_CLIENT_MCP === '1') {
    opts.log?.('Skipping client MCP refresh (CANARY_LAB_SKIP_CLIENT_MCP=1).')
    return
  }

  const base = {
    refreshOnly: true as const,
    force: true as const,
    log: opts.log,
    execPath: opts.execPath,
    cliPath: opts.cliPath,
  }
  registerCanaryLabMcp('codex', base)
  registerCanaryLabMcp('claude', base)

  const desktopConfigPath = opts.claudeDesktopConfigPath ?? claudeDesktopConfigPath(opts.homeDir)
  if (claudeDesktopInstalled(desktopConfigPath)) {
    registerClaudeDesktopMcp({ ...base, configPath: desktopConfigPath })
  }
}

export interface StaleMcpRegistration {
  client: string
  cliPath: string
}

// Every failure path in the refresh above is quiet: registerCanaryLabMcp reports
// "CLI not found on PATH" through a logger `upgrade --silent` suppresses, and
// upgrade wraps the whole call in a best-effort catch that discards the error.
// A refresh that does not land leaves the client invoking a cli.js the upgrade
// just deleted — the client then fails with no hint why.
//
// Checking the registered path against the filesystem catches that broken state
// whatever caused it, instead of trying to enumerate the causes.
export function findStaleCanaryLabMcp(deps: {
  readRegisteredCliPath?: (target: McpRegistrationTarget) => string | null
  exists?: (candidate: string) => boolean
} = {}): StaleMcpRegistration[] {
  const read = deps.readRegisteredCliPath ?? registeredCliPath
  const exists = deps.exists ?? ((candidate: string) => fs.existsSync(candidate))
  const stale: StaleMcpRegistration[] = []
  for (const target of ['codex', 'claude'] as const) {
    const cliPath = read(target)
    if (cliPath && !exists(cliPath)) {
      stale.push({ client: target === 'codex' ? 'Codex' : 'Claude', cliPath })
    }
  }
  return stale
}
