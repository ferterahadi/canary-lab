const config = {
  name: 'flaky_orders_api',
  description: 'Orders API with two bugs that only surface through runtime logs (env misparse, swallowed exception) — forces the heal loop to instrument, restart, and re-diagnose.',
  envs: ['local'],
  repos: [
    {
      name: 'flaky_orders_api',
      localPath: __dirname,
      startCommands: [
        {
          name: 'flaky-orders-api-server',
          command: 'npx tsx scripts/server.ts',
          // Per-run allocated port (injected as PORT); reference via ${port.api}.
          ports: [{ name: 'api', env: 'PORT' }],
          healthCheck: { http: { url: 'http://localhost:${port.api}/', timeoutMs: 3000 } },
        },
      ],
    },
  ],
  featureDir: __dirname,
}

module.exports = { config }
