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

/** HTTP/HTTPS readiness probe — should point at the LOCAL service. */
export interface HttpProbe {
  url: string
  /** Per-attempt timeout (ms). Defaults to 1500. */
  timeoutMs?: number
  /** Overall deadline before giving up (ms). Defaults to 60_000. */
  deadlineMs?: number
}

/** TCP-port-listening readiness probe — waits for `host:port` to accept connections. */
export interface TcpProbe {
  port: number
  /** Defaults to 127.0.0.1. */
  host?: string
  /** Per-attempt timeout (ms). Defaults to 1500. */
  timeoutMs?: number
  /** Overall deadline before giving up (ms). Defaults to 60_000. */
  deadlineMs?: number
}

/**
 * A single readiness probe. Exactly ONE transport key must be present.
 * `{ http: {...}, tcp: {...} }` is invalid — the validator rejects it at
 * load time.
 */
export type HealthProbe = { http: HttpProbe } | { tcp: TcpProbe }

/**
 * Backwards-compatible flat shape — older `feature.config.cjs` files wrote
 * the probe with `url` at the top level. Auto-coerced to
 * `{ http: { url, timeoutMs } }` at load time. New code should use the
 * tagged `HealthProbe` shape.
 */
export interface LegacyHealthProbe {
  url: string
  timeoutMs?: number
}

/**
 * Health check for a started command. Three shapes are accepted:
 *
 * 1. **Tagged probe** (`{ http: {...} }` or `{ tcp: {...} }`) — used for
 *    every env. Recommended for new code.
 * 2. **Legacy flat probe** (`{ url, timeoutMs }`) — back-compat with
 *    pre-multi-transport configs. Coerced to `{ http: {...} }` at load.
 * 3. **Env → probe map** — picked by the run's selected env. Each value is
 *    either shape (1) or shape (2). A `default` key is the fallback when
 *    no env matches; otherwise an unmatched env logs a warning and
 *    Playwright proceeds without waiting.
 */
export type HealthCheck =
  | HealthProbe
  | LegacyHealthProbe
  | { [envName: string]: HealthProbe | LegacyHealthProbe }

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
  // whole suite to finish. Omit to let the full suite finish before healing.
  healOnFailureThreshold?: number
}
