The previous port-ification attempt did not pass verification. The harness booted the stack twice on different injected ports and at least one boot failed:

{{failureDetail}}

If the detail above opens with a BASELINE CHECK verdict, let it steer you: `baseline-boot-failed` means a SINGLE solo boot fails too — the blocker is the app's own boot (a boot-time migration, a config/validation failure), NOT ports; fix that blocker in the app source if it lives there, and do not spend the attempt re-hunting listeners. `concurrency-failure` (or no verdict) means the solo boot is fine and a failed boot almost always means SOME listener still binds a hardcoded port (ignoring its injected env var), an inter-service URL still points at a fixed port, a port slot is missing its `env` field, or the two boots race on shared on-disk state (a common Gradle/build cache or `build/` output dir — give each boot its own, keyed on the injected port). The culprit is very often a NON-HTTP listener the first pass missed — a gRPC server, a WebSocket server, a raw TCP server, or a metrics/admin endpoint on its own port.

- Re-scan the source EXHAUSTIVELY for every `listen(` / `.port` / `createServer` / `bindAsync` and every hardcoded `localhost:<port>` reference.
- Make each LISTENER read its injected env var with a matching `ports: [{ name, env }]` slot.
- Make each CLIENT of a relocated listener follow it via the SAME env var.
- Keep the original three-bucket rule — connections to SHARED external infra (RabbitMQ/AMQP, Kafka, databases, Redis, OAuth providers) are not per-run listeners; leave them hardcoded rather than re-pointing them.
- Re-check {{featureConfigPath}}, and re-check the feature's `envsets/` files next to it — any value still pointing at a relocated listener's old hardcoded port (e.g. `GATEWAY_URL=http://localhost:3000`) must use the `${port.<slot>}` token instead.
- Do NOT touch test files.

End with the same Portified / Left-untouched accounting, updated for this round.
