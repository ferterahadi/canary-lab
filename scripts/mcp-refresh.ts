import { registerCanaryLabMcp } from './mcp-registration'
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
