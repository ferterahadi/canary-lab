You are making the app(s) for the Canary Lab feature "{{featureName}}" use INJECTABLE, DYNAMIC ports so the same app can boot multiple times concurrently (benchmark arms / parallel runs) without an EADDRINUSE clash.

You are working on a dedicated branch inside isolated git worktrees. Edit each repo's SOURCE in the worktree path listed below (NOT the original repo path), and edit the feature config at its real path. Do NOT commit — a human reviews and commits.

Repos / start commands in this feature:
{{reposSummary}}

Do ALL of the following:

1. SCAN every repo's source EXHAUSTIVELY for EVERY network listener that binds or listens on a port — NOT just the HTTP application gateway or the health-check endpoint. A single service often opens several listeners on several ports; you must find and portify ALL of them. Look for every kind of inbound listener, including:
   - HTTP / HTTPS servers (`app.listen(...)`, `http.createServer().listen(...)`, `server.port`, framework `PORT`)
   - gRPC servers (`server.bindAsync('0.0.0.0:50051', ...)`)
   - WebSocket servers (`new WebSocketServer({ port })`, socket.io)
   - raw TCP / `net` servers (`net.createServer().listen(port)`)
   - message-broker consumers/listeners that bind a port or connect to a fixed broker port — RabbitMQ/AMQP, Kafka, Redis, MQTT, NATS, etc.
   - metrics / admin / debug endpoints (Prometheus `/metrics`, pprof, separate health ports) on their own ports
   - any other service that accepts incoming connections or traffic on a port
   Search broadly — `listen(`, `.port`, `createServer`, `bindAsync`, `PORT`, `:3000`-style literals, and broker connection strings. Hardcoded ports hide in constants, config files, env defaults, and connection URLs, not only in the obvious entry point.

2. For EACH listener you found, make its port read an environment variable, with the current hardcoded value as the fallback — e.g. `process.env.PORT ?? 3007` (Node), `server.port=${PORT:3000}` (Spring), `process.env.GRPC_PORT ?? 50051`. Pick a clear, UNIQUE env var per listener (PORT, GRPC_PORT, WS_PORT, METRICS_PORT, AMQP_PORT, …).

3. Find every INTER-SERVICE reference that points at one of these ports (e.g. `http://localhost:3007`, `localhost:50051`, an AMQP/Kafka broker URL) and make it env-driven too, so a relocated listener stays reachable.

4. Update the feature config at {{featureConfigPath}}:
   - On each startCommand that boots listening service(s), declare a `ports: [{ name: '<slot>', env: '<ENV_VAR>' }]` slot for EVERY listener that service exposes — using the SAME env var the source now reads. The slot `env` is REQUIRED. One command may declare multiple slots.
   - Rewrite that command's `healthCheck` URL and any inter-service URL in the config to use the `${port.<slot>}` token instead of a hardcoded port, e.g. `http://localhost:${port.api}/health`.

5. Do NOT touch test files (anything under `e2e/` or matching `*.spec.[tj]s`). This is purely a port-injection change.

The harness will then boot the stack TWICE concurrently on two different injected port sets and require both to pass their health checks. A single leftover hardcoded listener — even a non-HTTP one (gRPC, WebSocket, TCP, AMQP, Kafka, metrics) — will make the second boot clash or hang, so be thorough: every port the app opens must be injectable.
