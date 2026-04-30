export interface RepoPrerequisite {
  name: string
  localPath: string      // absolute or ~/... path
  cloneUrl?: string      // shown if repo is missing
  // Each entry opens one iTerm tab in this repo's directory.
  // Use multiple entries when one repo needs multiple running processes.
  startCommands?: Array<string | StartCommand>
  // Whitelist of envs in which this repo's services should boot. Omit to
  // boot in every env. Use this to skip local services when running tests
  // against a remote URL (e.g. envs: ['local']).
  envs?: string[]
}

export interface HealthCheck {
  url: string
  timeoutMs?: number
}

export interface StartCommand {
  command: string
  name?: string
  healthCheck?: HealthCheck
  // Whitelist of envs in which this command should boot. Omit to boot in
  // every env. Per-command override of the repo-level `envs` field.
  envs?: string[]
}

export interface NgrokTunnel {
  port: number
  subdomain: string
}

export interface FeatureConfig {
  name: string
  description: string
  envs: string[]
  repos?: RepoPrerequisite[]
  tunnels?: NgrokTunnel[]              // used by the tunnel env — one ngrok tab per entry
  startScript?: Record<string, string> // optional override: env name → absolute path to tsx script
  featureDir: string                   // absolute path to feature folder
  // Mid-Run Heal: when set, Playwright is invoked with --max-failures=<N> so
  // the heal loop fires as soon as N tests fail rather than waiting for the
  // whole suite to finish. Defaults to 1 when omitted.
  healOnFailureThreshold?: number
}
