You are onboarding product repo(s) into a Canary Lab E2E workspace. Inspect the repo(s) below and draft the feature config that boots them for testing. Look wherever the stack actually declares how to run: package.json scripts and lockfiles (Node), go.mod + cmd/ layout (Go), pyproject.toml/requirements.txt (Python), Cargo.toml (Rust), pom.xml/build.gradle (JVM), *.csproj (.NET), Gemfile (Ruby), Makefiles, Procfiles, docker-compose files, and READMEs. Do not assume Node — a repo with no package.json still boots (e.g. `go run .`, `./mvnw spring-boot:run`).

An "env file" is whatever file THIS repo reads its local config/secrets from — it is NOT only `.env`. Detect it per stack, do not assume `.env`:
- Node / Vite / Next: `.env`, `.env.local`, `.env.development`, `.env.*`
- JVM / Spring: `src/main/resources/application.properties` / `application.yml` and profile variants like `application-local.properties` / `application-local.yml`
- .NET: `appsettings.json`, `appsettings.Development.json`, `appsettings.*.json`
- Ruby / Rails: `config/database.yml`, `config/secrets.yml`, `config/credentials/*`, and `.env*` if `dotenv` is present
- Python: `.env`, or a settings module / `*.ini` / `*.cfg` the app reads
- Generic: any tracked `*.local.*`, `*.example`/`*.sample` (report the real file the example implies), or a path the boot command/README points at

Report the actual file(s) the app reads at boot for the chosen start command — the real path, not the `.example`. When a repo genuinely reads none, return `[]`.

Repos (one feature spans all of them):
{{repoPaths}}
What to test: {{description}}
{{feedbackNote}}

Reply with ONLY a JSON object in a ```json fence, shaped exactly:
{ "configSource": "<complete feature.config.cjs source>", "envFiles": ["<absolute path of each env file the app reads>"] }

configSource is a single JSON string — escape every newline as \n and escape quotes/backslashes; the whole reply must parse with JSON.parse. Example: `{ "configSource": "const config = {\n  name: 'checkout',\n}\nmodule.exports = { config }\n", "envFiles": [] }`.

If you cannot determine how a repo boots, still return the JSON with your best single startCommand and state the uncertainty in the description field — never return prose instead of JSON.

The configSource must be CommonJS shaped exactly `const config = {...}\nmodule.exports = { config }` with:
- name: {{featureJson}}, description: {{descriptionJson}}, envs: [{{envJson}}], featureDir: __dirname
- repos: one entry per repo above: { name, localPath (the absolute path above), branch: the output of `git -C <repo> branch --show-current`; omit when empty/detached, startCommands: [...] }
- each startCommand: { command, name, ports: [{ name: '<slot>', env: 'PORT' }] when the service reads a port env var, healthCheck: { http: { url: 'http://localhost:${port.<slot>}/<ready-path>' } } or { tcp: { port: '${port.<slot>}' } } }
- envFiles: [] when the app reads no env files.
- ALWAYS declare a port slot and reference it via ${port.<slot>} in the healthCheck — in the http url AND in tcp.port (which takes the token string `'${port.<slot>}'`, not a bare number) — never hardcode a port number, so concurrent runs don't clash.
- If the service reads its port from an env var other than PORT, set that var name in ports[].env. If it only takes the port as a command-line flag, interpolate the slot into the command itself (e.g. `go run . -port ${port.api}`) — ${port.<slot>} resolves anywhere in the config, not just health checks.
- Use healthCheck.http for anything that serves HTTP (a /health, /ready, or the root path); use healthCheck.tcp for a service that listens but doesn't speak HTTP. Every long-running service needs one or the other — the harness proves boot with it.
- pick the dev/start command a developer would actually use (prefer the repo's own script/task runner: package.json scripts, Makefile targets, `go run .`); use the shortest command that boots the service ready for E2E.
Do not invent services that don't exist. Do not include commentary outside the JSON fence.
