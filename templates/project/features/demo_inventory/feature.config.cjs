const path = require('node:path')

// The inventory service of the demo storefront — the demo's KNOWN-GOOD feature.
// Its suite passes as shipped, which is what makes it the Benchmark's subject:
// the benchmark sabotages a working app and scores an agent on whether the
// suite comes back green, so it needs a baseline that is green to begin with.
//
// It is also the first thing a new workspace can Run and see succeed. Its
// sibling `demo_catalog` is the one with planted defects — use that to watch a
// repair. Leave this one working.
//
// Like demo_catalog, `localPath` points OUTWARD at the product code rather than
// at this folder: the feature and the app it tests are separate things.

const config = {
  name: 'demo_inventory',
  description: 'Inventory service of the demo storefront — the known-good feature; its suite passes as shipped.',
  envs: ['local'],
  repos: [
    {
      name: 'inventory_service',
      localPath: path.join(__dirname, '..', '..', 'demo-app', 'inventory-service'),
      startCommands: [
        {
          name: 'inventory-service',
          command: 'npx tsx server.ts',
          // Canary Lab allocates a free port per run (injected as PORT) so two
          // local runs never clash. Reference it via `${port.api}`.
          ports: [{ name: 'api', env: 'PORT' }],
          healthCheck: { http: { url: 'http://localhost:${port.api}/', timeoutMs: 3000 } },
        },
      ],
    },
  ],
  featureDir: __dirname,
}

module.exports = { config }
