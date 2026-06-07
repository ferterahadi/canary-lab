You are making the app(s) for the Canary Lab feature "{{featureName}}" use INJECTABLE, DYNAMIC ports so the same app can boot multiple times concurrently (benchmark arms / parallel runs) without an EADDRINUSE clash.

You are working on a dedicated branch inside isolated git worktrees. Edit each repo's SOURCE in the worktree path listed below (NOT the original repo path), and edit the feature config at its real path. Do NOT commit — a human reviews and commits.

Repos / start commands in this feature:
{{reposSummary}}

Do ALL of the following:

1. In each service's SOURCE, find where it binds its listen port (e.g. `app.listen(3007)`, `server.port=3000`, a hardcoded constant). Make it read an environment variable with the hardcoded value as fallback, e.g. `process.env.PORT ?? 3007` (Node) or `server.port=${PORT:3000}` (Spring). Pick a clear env var name per service (PORT, RECOVERY_PORT, OMS_PORT, …).

2. Find every INTER-SERVICE URL that points at one of these hardcoded ports (e.g. `http://localhost:3007`) and make it env-driven too, so a relocated service is still reachable.

3. Update the feature config at {{featureConfigPath}}:
   - On each startCommand that boots a listening service, declare `ports: [{ name: '<slot>', env: '<ENV_VAR>' }]` — the SAME env var the source now reads. The slot `env` is REQUIRED.
   - Rewrite that command's `healthCheck` URL (and any inter-service URL in the config) to use the `${port.<slot>}` token instead of a hardcoded port, e.g. `http://localhost:${port.api}/health`.

4. Do NOT touch test files (anything under `e2e/` or matching `*.spec.[tj]s`). This is purely a port-injection change.

The harness will then boot the stack TWICE concurrently on two different injected port sets and require both to pass their health checks. Make the change complete enough that both boots succeed.
