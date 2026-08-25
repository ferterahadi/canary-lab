import fs from 'fs'
import {
  registerCanaryLabMcp,
  registeredCliPath,
  resolveCliPath,
  isTempInstallPath,
  type McpRegistrationTarget,
} from './mcp-registration'
import {
  registerClaudeDesktopMcp,
  registeredDesktopCliPath,
  claudeDesktopConfigPath,
  claudeDesktopInstalled,
  type DesktopRegistrationResult,
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

  // A temp install must not claim the user's global pointers — see isTempInstallPath.
  // Checked against the path we WOULD register, so an explicit durable `cliPath`
  // (init passes the stable node_modules one) is still allowed through.
  if (isTempInstallPath(opts.cliPath ?? resolveCliPath())) {
    opts.log?.('Skipping client MCP refresh — this install lives under the temp directory.')
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

export interface QuietDesktopRefreshOptions {
  /** Home the Desktop config is resolved under. Defaults to CANARY_LAB_AGENT_HOME
   *  (the same seam `upgrade` uses), which keeps tests off the real config. */
  homeDir?: string
  configPath?: string
  execPath?: string
  cliPath?: string
  /** Workspace to pin the refreshed entry to. See registerClaudeDesktopMcp. */
  projectRoot?: string
}

// Re-assert ONLY the Claude Desktop entry, for the `canary-lab ui` boot.
//
// Upgrade-time cannot be the last word for Desktop. Desktop owns
// claude_desktop_config.json and rewrites the whole file from a copy it loaded
// at launch, so an instance running across an upgrade puts the pre-upgrade entry
// back minutes after `upgrade` healed it — pointing at a cli.js the upgrade
// deleted. The user sees "Server disconnected" and nothing else. `ui` is the
// command they run every session, so it is where that revert gets caught.
//
// Desktop-only on purpose: codex/claude are re-pointed by `upgrade` and cannot
// revert themselves, and shelling out to two client CLIs on every boot is not free.
export function refreshClaudeDesktopMcpQuietly(
  opts: QuietDesktopRefreshOptions = {},
): DesktopRegistrationResult {
  // Same guard as refreshCanaryLabMcp: the tarball smoke test boots a throwaway
  // install and must never re-point the developer's live Desktop config at it.
  if (process.env.CANARY_LAB_SKIP_CLIENT_MCP === '1') return 'skipped'
  // A temp install must not claim the user's global pointers — see isTempInstallPath.
  // Checked against the path we WOULD register, so an explicit durable `cliPath`
  // (init passes the stable node_modules one) is still allowed through.
  if (isTempInstallPath(opts.cliPath ?? resolveCliPath())) return 'skipped'
  try {
    const configPath = opts.configPath
      ?? claudeDesktopConfigPath(opts.homeDir ?? process.env.CANARY_LAB_AGENT_HOME)
    if (!claudeDesktopInstalled(configPath)) return 'skipped'
    return registerClaudeDesktopMcp({
      refreshOnly: true,
      force: true,
      configPath,
      execPath: opts.execPath,
      cliPath: opts.cliPath,
      // The booting workspace is the one to pin: this refresh runs from
      // `canary-lab ui`, which is also what records the live server the pin
      // resolves to. Omitting it here would strip a pin `setup` just wrote.
      ...(opts.projectRoot ? { projectRoot: opts.projectRoot } : {}),
      // The caller reports the outcome from the return value; the writer's own
      // "already configured" line would be noise on every single boot.
      log: () => {},
    })
  } catch {
    // Best-effort: an unreadable or read-only Desktop config must never block
    // `canary-lab ui` from starting.
    return 'skipped'
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
  readDesktopCliPath?: () => string | null
  /** Home the Desktop config is read from. Must match the home the refresh
   *  wrote to, or this reports a stale entry against a config nothing touched —
   *  the tarball smoke test runs under its own home and would otherwise warn
   *  about the developer's real Desktop install. */
  homeDir?: string
  exists?: (candidate: string) => boolean
} = {}): StaleMcpRegistration[] {
  const read = deps.readRegisteredCliPath ?? registeredCliPath
  const readDesktop = deps.readDesktopCliPath
    ?? (() => registeredDesktopCliPath(claudeDesktopConfigPath(deps.homeDir)))
  const exists = deps.exists ?? ((candidate: string) => fs.existsSync(candidate))
  const stale: StaleMcpRegistration[] = []
  for (const target of ['codex', 'claude'] as const) {
    const cliPath = read(target)
    if (cliPath && !exists(cliPath)) {
      stale.push({ client: target === 'codex' ? 'Codex' : 'Claude', cliPath })
    }
  }
  // Desktop is read from its config file, not a client CLI, so it needs its own
  // arm rather than another loop entry. Leaving it out made this check blind to
  // the one client that can revert a healed entry on its own — the likeliest way
  // a registration ends up stale, and the hardest for a user to diagnose.
  const desktopCliPath = readDesktop()
  if (desktopCliPath && !exists(desktopCliPath)) {
    stale.push({ client: 'Claude Desktop', cliPath: desktopCliPath })
  }
  return stale
}
