import { execFile } from 'child_process'

// Detect-and-instruct wrapper around the GitHub CLI (`gh`). Canary NEVER runs
// `gh auth login`, never performs the OAuth device flow, and never handles the
// token value — the token stays in gh's own keyring. We only READ status
// (side-effect-free) so the UI can say "connected as X" or surface the exact
// command the user should run themselves. Every function degrades gracefully
// when gh is missing or the user isn't signed in.

export interface GhResult {
  code: number
  stdout: string
  stderr: string
}

/** Run a `gh` subcommand. Never pass a subcommand that mutates auth state or
 *  prints the raw token (`gh auth token`) — status/read commands only. */
export function runGh(args: string[]): Promise<GhResult> {
  return new Promise((resolve) => {
    const child = execFile('gh', args, { timeout: 15_000 }, (error, stdout, stderr) => {
      const code = typeof (error as { code?: unknown } | null)?.code === 'number'
        ? (error as { code: number }).code
        : error ? 1 : 0
      resolve({ code, stdout: String(stdout), stderr: String(stderr) })
    })
    child.on('error', (err) => resolve({ code: 127, stdout: '', stderr: err.message }))
  })
}

export interface GhStatus {
  /** `gh` is on PATH. */
  installed: boolean
  /** A stored credential exists for the host (from `gh auth status`, local — no
   *  network call, and the token itself is masked and never captured). */
  authenticated: boolean
  /** The signed-in GitHub login, when it could be parsed. */
  account?: string
  /** The host the account is on (github.com or an enterprise host). */
  host?: string
}

/**
 * Read gh's local auth status. No network call, no token handling. Shapes:
 * `{installed:false}` → tell the user `brew install gh`; `{installed:true,
 * authenticated:false}` → `gh auth login`; `{authenticated:true, account}` →
 * "connected as <account>".
 */
export async function detectGhStatus(
  run: (args: string[]) => Promise<GhResult> = runGh,
): Promise<GhStatus> {
  const version = await run(['--version'])
  if (version.code !== 0) return { installed: false, authenticated: false }
  // `gh auth status` is local: it reads the stored credential and masks the
  // token in its output — we parse only the host + login, never the token.
  const status = await run(['auth', 'status'])
  if (status.code !== 0) return { installed: true, authenticated: false }
  const out = `${status.stdout}\n${status.stderr}`
  // Handles both the older "Logged in to github.com as <user>" and the newer
  // "Logged in to github.com account <user>" phrasings.
  const m = out.match(/Logged in to (\S+) (?:as|account) (\S+)/)
  return { installed: true, authenticated: true, host: m?.[1], account: m?.[2] }
}

/** Parse `owner/name` from a GitHub remote URL (ssh or https). Null when the
 *  URL isn't a github remote we recognize. */
export function parseGitHubRemote(url: string): { owner: string; name: string; host: string } | null {
  const trimmed = url.trim()
  // git@github.com:owner/name.git  |  ssh://git@github.com/owner/name.git
  const ssh = trimmed.match(/^(?:ssh:\/\/)?[^@]+@([^:/]+)[:/]([^/]+)\/(.+?)(?:\.git)?$/)
  if (ssh) return { host: ssh[1], owner: ssh[2], name: ssh[3] }
  // https://github.com/owner/name.git
  const https = trimmed.match(/^https?:\/\/(?:[^@]+@)?([^/]+)\/([^/]+)\/(.+?)(?:\.git)?$/)
  if (https) return { host: https[1], owner: https[2], name: https[3] }
  return null
}

export interface RepoPushRights {
  pushable: boolean
  /** Why not, when `pushable` is false (no access under the signed-in account,
   *  private repo, or gh error) — surfaced verbatim so the user can act. */
  reason?: string
}

/**
 * Side-effect-free push-rights probe for one repo via the GitHub API's
 * `permissions.push` flag. Catches the wrong-account case (the user is signed
 * in, but as a personal login with no push access to the org repo).
 */
export async function detectRepoPushRights(
  owner: string,
  name: string,
  run: (args: string[]) => Promise<GhResult> = runGh,
): Promise<RepoPushRights> {
  const res = await run(['api', `repos/${owner}/${name}`, '--jq', '.permissions.push'])
  if (res.code !== 0) {
    const reason = res.stderr.trim() || res.stdout.trim() || 'repo not accessible under the signed-in account'
    return { pushable: false, reason: firstLine(reason) }
  }
  return { pushable: res.stdout.trim() === 'true' }
}

function firstLine(s: string): string {
  return s.split('\n').map((l) => l.trim()).filter(Boolean)[0] ?? s
}
