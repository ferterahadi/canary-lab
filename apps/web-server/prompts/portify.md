Make every listener for "{{featureName}}" use injectable ports so the app can boot
concurrently without `EADDRINUSE`.

Edit source only in the listed throwaway worktrees, but edit the feature config and
envsets at their real paths. Do not commit or merge. Source changes become an
ephemeral overlay applied per run and reversed at teardown; config and envset
changes persist because they declare Canary Lab's port slots. A human reviews and
saves the overlay; the scratch worktree is discarded and product repos stay unchanged.

Repos / start commands in this feature:
{{reposSummary}}

## Fan out across repos, then do the shared files yourself

With several repos, dispatch one subagent per repo in one round (up to 5). Each
scans and edits only its worktree and returns section-10 accounting. You alone edit
the shared feature config and envsets, then merge the report. A silent return is
unfinished; inspect that repo yourself. Double-boot may miss lazy or crash-tolerant
listeners, so verify the scan.

## The goal, and the mental model that makes it correct

The harness boots the stack twice on separate port sets. Both boots must pass;
every bound port must come from an environment variable.

Before touching anything, classify each port reference you find into exactly one of three buckets — they get different treatment:

- **A LISTENER binds a port** (it owns the socket: `app.listen(3000)`, a TCP/gRPC/WebSocket/metrics server). This is the clash risk. → **Make it injectable (sections 2–3).** This is the primary target.
- **A CLIENT connects to another *local* service you relocated** (e.g. the gateway dials the recovery service at `localhost:3007`). It doesn't clash, but it will dial the wrong place once that listener moves. → **Make it env-driven too so it follows the relocation (section 4).**
- **A CLIENT connects to SHARED external infra** — a message broker (RabbitMQ `:5672`, Kafka `:9092`), a shared database, Redis, an OAuth provider. This is NOT booted per-run, two app instances connecting to it is fine, and relocating it would BREAK the app. → **Leave it untouched and say so in the report (section 8).** Do not env-rewrite a shared-broker connection just because it has a port in it.

The trap: a constant can *look* like a listener port and bind nothing. An `enum Port { … }` that no production code imports (only its own `.spec.ts`, and not re-exported from the barrel) is **dead code** — converting it changes nothing and is not required, but you MUST verify usage before deciding and record the decision (section 8). Trace each candidate to where the value is actually passed to a `listen`/`bind` call.

## 1. Scan EXHAUSTIVELY for every listener

A single service often opens several listeners on several ports — not just the HTTP gateway or the health endpoint. Find ALL of them. Listener kinds to hunt for:

- HTTP / HTTPS servers — `app.listen(...)`, `http.createServer().listen(...)`, framework `PORT`, `server.port`
- gRPC servers — `server.bindAsync('0.0.0.0:50051', ...)`
- WebSocket servers — `new WebSocketServer({ port })`, socket.io
- raw TCP / `net` servers — `net.createServer().listen(port)`, NestJS `Transport.TCP` microservices (`connectMicroservice({ transport: Transport.TCP, options: { port } })`)
- metrics / admin / debug / separate health ports — Prometheus `/metrics`, pprof, a sidecar health server on its own port
- any other server that accepts inbound connections on a port

How to search — cast a wide net, because hardcoded ports hide in constants, config files, env defaults, and connection URLs, not just the entry point:

- Grep each worktree for: `listen(`, `bindAsync`, `createServer`, `.port`, `PORT`, and bare `:3000`-style literals (`:30\d\d`, `:50\d\d`, etc.).
- For every `Port`-like enum/const you find, grep for who imports and USES each member — only members that flow into a `listen`/`bind` call are real listeners. Note duplicates: two enums can both define `RECOVERY = 3007`; only the one that's actually bound matters.
- Open framework config files too (see section 6).

## 2. Make each listener's port read an env var (with the current value as fallback)

For EACH real listener, replace the hardcoded port with `process.env.<VAR> ?? <current>`, keeping the old value as the default. Pick a clear, UNIQUE var per listener: `PORT`, `GATEWAY_PORT`, `GRPC_PORT`, `WS_PORT`, `METRICS_PORT`, `REPORT_PORT`, …

Language gotchas — get these right or the boot fails in confusing ways:

- **Numbers, not strings.** `process.env.X` is a string; APIs that demand a number (`app.listen`, NestJS `port:`, `net` options) need `Number(process.env.X ?? 3007)`. Wrap it.
- **TypeScript `enum` can't hold computed values.** `enum Port { A = process.env.X ?? 3000 }` does not compile — enum members need constant initializers. Convert the enum to a `const` object: `export const Port = { REPORT: Number(process.env.REPORT_PORT ?? 3004) } as const`. Keep the same name and member keys so call sites (`Port.REPORT`) are unchanged.
- **Spring / properties files** — `server.port=${PORT:3000}` (or in YAML, `port: ${PORT:3000}`).
- Leave anything that ALREADY reads an env var alone (it's done) — just confirm the var name lines up with the feature config (section 5).

## 3. Re-point inter-service references at the relocated listeners

For every CLIENT call that targets a local listener you just moved — `http://localhost:3007`, `localhost:50051`, a TCP client's `{ host, port }`, an inter-service base URL — make the port env-driven too, reading the SAME var the listener now reads, so the caller follows the listener to its injected port. (Shared-broker / external connections from the mental model stay as-is — do not touch them here.)

**Keep the current value as the fallback here too** — `Number(process.env.RECOVERY_PORT ?? 3007)`, never a bare `process.env.X`. This is what makes the rewrite reusable: the saved patch is per-REPO, so another feature that uses this app WITHOUT its peers will borrow these same lines. With a fallback, an un-injected peer is dialled exactly where it always was; without one, that feature gets `undefined`/`NaN` and fails for a reason no health check reports.

## 4. Update the feature config at {{featureConfigPath}}

- On EACH `startCommand` that boots listening service(s), declare a `ports: [{ name: '<slot>', env: '<ENV_VAR>' }]` slot for EVERY listener that command exposes — using the SAME env var name the source now reads. The slot `env` is REQUIRED. When a command exposes exactly one listener, name the slot exactly the same as the start command's `name`; specs authored before this stage already reserve that stable slot. Canary exposes its Playwright key with every character outside letters, digits, and `_` normalized to `_` (slot `checkout-service` becomes `CANARY_PORT_checkout_service`) because interactive shells drop invalid environment names. One command that boots a whole stack (e.g. `yarn start:all:dev`) declares MULTIPLE slots, one per listener.
- A slot is how the port gets injected; it is independent of whether that port is health-checked. Every binding listener needs a slot even if nothing health-checks it — otherwise the second boot reuses the hardcoded fallback and clashes.
- Rewrite the command's `healthCheck` URL and any inter-service URL in the config to use the `${port.<slot>}` token instead of a hardcoded port — e.g. `http://localhost:${port.gateway}/healthz`.

## 5. Make the health check port-stable

The health check must prove THIS boot bound ITS injected port:

- Point the `healthCheck` at the primary externally-reachable service's injected port via `${port.<slot>}`.
- Prefer an endpoint that reflects only whether the service's own HTTP server is up — decoupled from whether downstream dependencies are healthy. If the existing health route returns non-2xx when a dependency is down, add (or target) a lightweight liveness route (e.g. `/healthz` returning `{ status: 'OK' }`) so a slow/unavailable dependency doesn't fail the port check.
- Give multi-service stacks a generous `deadlineMs` (the whole stack has to come up), and a `timeoutMs` that tolerates a cold start (e.g. `deadlineMs: 120000, timeoutMs: 5000`).

## 6. Don't forget config files and env defaults

Ports hide outside `.ts`/`.js` source:

- Spring `application.properties` / `application.yml` (`server.port`), and any `*.properties` listing service URLs.
- `.env` / `.env.local` / `.env.example` default port values.
- `docker-compose.yml` port mappings and service URLs, `nginx`/proxy configs, Procfiles.

## 6b. Rewrite the feature's envsets — a hardcoded URL there is silently broken

The feature has envset files under `envsets/<env>/` next to {{featureConfigPath}}. They are applied at boot, BEFORE port injection, and `${port.<slot>}` tokens inside them resolve to the run's assigned ports. They are part of this job:

- Scan EVERY envset file (`.env` / `.properties` / `.env.local`) for values that point at a listener you relocated — e.g. `GATEWAY_URL=http://localhost:3000`. After your rewrite that listener boots on an injected port, so the hardcoded value dials a dead (or worse, *another run's*) port. Verification will NOT catch this — health checks don't read these values; the feature's tests do, and they'd fail later for a reason nobody connects back to port-ification.
- Rewrite each such value to the token form: `GATEWAY_URL=http://localhost:${port.gateway}`, using the slot you declared for that listener.
- Apply the same three-bucket test as everywhere else: values pointing at SHARED external infra (broker URIs like `amqp://localhost:5672`, management consoles, DBs, Redis, OAuth issuers) are NOT per-run listeners — leave them hardcoded and list them in the report.
- The harness applies the envset's NON-port content into the worktree for you during the double-boot verification — so a checked-in config value that differs from the captured envset (e.g. a docker-compose `db` datasource host where the envset says `localhost`) is already handled. Do NOT "repair" datasource hosts, credentials, or other env values in the worktree source; port wiring is the only in-scope source change.
- One caveat: DURING the double-boot, `${port.<slot>}` tokens inside envset files stay UNRESOLVED (one shared worktree boots twice — a single file can't carry two port maps). Anything that must follow an injected port during verification needs per-process wiring (an env var the source reads, or a CLI arg); the token form still resolves at real run boots.

## 7. Do NOT touch test files

Anything under `e2e/` or matching `*.spec.[tj]s` / `*.test.[tj]s` is off-limits. This is purely a port-injection change. (Test helpers already resolve the target as the shell-safe `CANARY_PORT_<env-slot>` → a URL env var → a hardcoded default; you don't need to edit them.)

## 8. Flag what you CANNOT relocate

Some ports are fixed by something outside the app and converting them won't help — call these out in the report instead of silently breaking them:

- **OAuth / OIDC** issuer + redirect URIs are pre-registered with the provider for a specific host:port. Relocating the listener breaks the callback. Such a feature can only run one-at-a-time — note it.
- **Ports hardcoded deep in a dependency or compiled artifact** that ignore env/`--port`/config — note that they can't be relocated from source.
- **Shared external infra** (broker, DB, Redis) — as in the mental model, left as-is on purpose.

## 9. Self-verify before finishing

- Re-grep each worktree for the original hardcoded port literals; every remaining one should be a fallback default (`?? 3007`), a test file, or an item you justified in section 8.
- Re-grep for the env vars you introduced: every read — listener (section 2) AND client re-point (section 3) — must carry its original value as the fallback. A bare `process.env.X` with no `??` is the one form that breaks another feature borrowing this patch.
- Re-grep the feature's `envsets/` for `localhost:<digits>` (and the original port literals); every hit should be shared external infra (section 6b) — anything targeting a relocated listener must use `${port.<slot>}`.
- Confirm each feature-config slot `env` matches a var the source actually reads, and each `${port.<slot>}` token names a slot you declared.
- If a typecheck/build is cheap in the worktree, run it — the enum→const change is exactly the kind that breaks types at call sites.

## 10. Report what you did

Output a concise accounting of EVERY port-like construct you encountered — each `Port` enum/const, hardcoded `:PORT` literal, `listen(...)`/`bindAsync(...)`/`createServer` call, config-file port, and broker/client connection — split into:

- **Portified** — what you converted, the env var assigned, and the matching feature-config slot.
- **Left untouched** — with a ONE-LINE reason each: e.g. "dead code: no production importers, only referenced by its own `.spec.ts`"; "already env-driven"; "shared RabbitMQ broker, not per-run"; "OAuth redirect pre-registered — runs one at a time"; "test file".

This report is for the human reviewer. Make a deliberately-skipped duplicate distinguishable from an oversight — a port-shaped construct you didn't trace is a bug, not a skip.

Use this skeleton:

```
Portified:
- ...

Left untouched (already env-driven):
- ...

Left untouched (needs discussion):
- ...

Verification notes:
- ...
```

---

A single leftover hardcoded listener — even a non-HTTP one (gRPC, WebSocket, TCP, metrics) — makes the second concurrent boot clash or hang. Be exhaustive: every port the app *binds* must be injectable.
