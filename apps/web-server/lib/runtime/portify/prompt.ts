import type { FeatureConfig } from '../../../../../shared/launcher/types'

// Prompts driving the port-ification agent. Attempt 1 gets the full task;
// retries get the same task plus the verification failure so the agent can fix
// what it missed (a hardcoded port, an inter-service URL, a slot without env).

function featureConfigPath(feature: FeatureConfig): string {
  return `${feature.featureDir}/feature.config.cjs`
}

export interface RepoEditTarget {
  name: string
  /** Where to edit this repo's SOURCE — its isolated worktree path. */
  editPath: string
}

function reposSummary(feature: FeatureConfig, targets: RepoEditTarget[]): string {
  return (feature.repos ?? [])
    .map((r) => {
      const target = targets.find((t) => t.name === r.name)
      const cmds = (r.startCommands ?? [])
        .map((c) => (typeof c === 'string' ? c : c.command))
        .map((c) => `      - ${c}`)
        .join('\n')
      return `  • ${r.name} — edit source in: ${target?.editPath ?? r.localPath}\n${cmds || '      (no start commands)'}`
    })
    .join('\n')
}

export function buildPortifyPrompt(feature: FeatureConfig, targets: RepoEditTarget[]): string {
  return `You are making the app(s) for the Canary Lab feature "${feature.name}" use INJECTABLE, DYNAMIC ports so the same app can boot multiple times concurrently (benchmark arms / parallel runs) without an EADDRINUSE clash.

You are working on a dedicated branch inside isolated git worktrees. Edit each repo's SOURCE in the worktree path listed below (NOT the original repo path), and edit the feature config at its real path. Do NOT commit — a human reviews and commits.

Repos / start commands in this feature:
${reposSummary(feature, targets)}

Do ALL of the following:

1. In each service's SOURCE, find where it binds its listen port (e.g. \`app.listen(3007)\`, \`server.port=3000\`, a hardcoded constant). Make it read an environment variable with the hardcoded value as fallback, e.g. \`process.env.PORT ?? 3007\` (Node) or \`server.port=\${PORT:3000}\` (Spring). Pick a clear env var name per service (PORT, RECOVERY_PORT, OMS_PORT, …).

2. Find every INTER-SERVICE URL that points at one of these hardcoded ports (e.g. \`http://localhost:3007\`) and make it env-driven too, so a relocated service is still reachable.

3. Update the feature config at ${featureConfigPath(feature)}:
   - On each startCommand that boots a listening service, declare \`ports: [{ name: '<slot>', env: '<ENV_VAR>' }]\` — the SAME env var the source now reads. The slot \`env\` is REQUIRED.
   - Rewrite that command's \`healthCheck\` URL (and any inter-service URL in the config) to use the \`\${port.<slot>}\` token instead of a hardcoded port, e.g. \`http://localhost:\${port.api}/health\`.

4. Do NOT touch test files (anything under \`e2e/\` or matching \`*.spec.[tj]s\`). This is purely a port-injection change.

The harness will then boot the stack TWICE concurrently on two different injected port sets and require both to pass their health checks. Make the change complete enough that both boots succeed.`
}

export function buildPortifyRetryPrompt(feature: FeatureConfig, failureDetail: string): string {
  return `The previous port-ification attempt did not pass verification. The harness booted the stack twice on different injected ports and at least one boot failed:

${failureDetail}

A failed boot almost always means a service still binds a hardcoded port (ignoring its injected env var), an inter-service URL still points at a fixed port, or a port slot is missing its \`env\` field. Re-check the source AND ${featureConfigPath(feature)}, fix what you missed, and make sure every listening service reads its injected env var. Do NOT touch test files.`
}
