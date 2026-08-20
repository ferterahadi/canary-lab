The previous port-ification attempt did not pass verification. The harness booted the stack twice on different injected ports and at least one boot failed:

{{failureDetail}}

Use any BASELINE CHECK verdict:

- `baseline-boot-failed`: one boot also fails. Fix the app's boot blocker, such as a
  migration or config error; this is not a port failure, so do not re-scan ports first.
- `concurrency-failure` or no verdict: the solo boot works. Look for a hardcoded
  listener, fixed local URL, missing slot `env`, or shared on-disk state. Give each
  boot its own build/cache/output directory keyed on an injected port. The missed
  culprit is often a NON-HTTP listener: a gRPC server, WebSocket server, raw TCP
  server, or metrics/admin endpoint.

- Re-scan the source EXHAUSTIVELY for every `listen(` / `.port` / `createServer` / `bindAsync` and every hardcoded `localhost:<port>` reference.
- Make each LISTENER read its injected env var with a matching `ports: [{ name, env }]` slot.
- Make each CLIENT of a relocated listener follow it via the SAME env var.
- Keep the original three-bucket rule — connections to SHARED external infra (RabbitMQ/AMQP, Kafka, databases, Redis, OAuth providers) are not per-run listeners; leave them hardcoded rather than re-pointing them.
- Re-check {{featureConfigPath}}, and re-check the feature's `envsets/` files next to it — any value still pointing at a relocated listener's old hardcoded port (e.g. `GATEWAY_URL=http://localhost:3000`) must use the `${port.<slot>}` token instead.
- Do NOT touch test files.

End with the same Portified / Left-untouched accounting, updated for this round.
