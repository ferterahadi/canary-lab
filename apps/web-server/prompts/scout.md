You are onboarding product repo(s) into a Canary Lab E2E workspace. Inspect the repo(s) below — package.json scripts, lockfiles, Procfiles, docker-compose files, READMEs, .env* files — and draft the feature config that boots them for testing.

Repos (one feature spans all of them):
{{repoPaths}}
What to test: {{description}}

Reply with ONLY a JSON object in a ```json fence, shaped exactly:
{ "configSource": "<complete feature.config.cjs source>", "envFiles": ["<absolute path of each env file the app reads>"] }

The configSource must be CommonJS shaped exactly `const config = {...}\nmodule.exports = { config }` with:
- name: {{featureJson}}, description: {{descriptionJson}}, envs: [{{envJson}}], featureDir: __dirname
- repos: one entry per repo above: { name, localPath (the absolute path above), branch (current branch if obvious, else omit), startCommands: [...] }
- each startCommand: { command, name, ports: [{ name: '<slot>', env: 'PORT' }] when the service reads a port env var, healthCheck: { http: { url: 'http://localhost:${port.<slot>}/<ready-path>' } } or { tcp: { port } } }
- ALWAYS declare a port slot and reference it via ${port.<slot>} in the healthCheck URL — never hardcode the port number in the URL — so concurrent runs don't clash. If the service reads its port from an env var other than PORT, set that var name in ports[].env.
- pick the dev/start command a developer would actually use (prefer package.json scripts); use the shortest command that boots the service ready for E2E.
Do not invent services that don't exist. Do not include commentary outside the JSON fence.
