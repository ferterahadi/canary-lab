const path = require('node:path')

// The catalog service of the demo storefront, already onboarded so a brand-new
// workspace has something to Run immediately. Note that `localPath` points
// OUTWARD at the product code rather than at this folder: the feature and the
// app it tests are separate things, which is how your own features will look.
//
// Its sibling, demo-app/checkout-service, is deliberately left un-onboarded so
// a flight has something to build from scratch. Nothing here may point at it.

const config = {
  name: 'demo_catalog',
  description: 'Catalog service of the demo storefront — ships with two planted defects for the repair loop.',
  envs: ['local', 'production'],
  repos: [
    {
      name: 'catalog_service',
      localPath: path.join(__dirname, '..', '..', 'demo-app', 'catalog-service'),
      startCommands: [
        {
          name: 'catalog-service',
          command: 'npx tsx server.ts',
          // Only boot the local service when running in `local`. Selecting
          // `production` skips startup and the production envset points
          // GATEWAY_URL at the remote URL instead.
          envs: ['local'],
          // Canary Lab allocates a free port per run (injected as PORT) so two
          // local runs never clash. Reference it via `${port.api}`.
          ports: [{ name: 'api', env: 'PORT' }],
          // Per-env readiness probe. Exactly one transport per probe:
          //   http: { url, timeoutMs?, deadlineMs? }
          //   tcp:  { port, host?, timeoutMs?, deadlineMs? }
          healthCheck: {
            local:      { http: { url: 'http://localhost:${port.api}/', timeoutMs: 3000 } },
            production: { http: { url: 'https://example.com/healthz', timeoutMs: 3000 } },
          },
        },
      ],
    },
  ],
  featureDir: __dirname,
}

module.exports = { config }
