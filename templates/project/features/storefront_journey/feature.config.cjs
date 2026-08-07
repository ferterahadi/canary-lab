const path = require('node:path')

// Three services, one runtime command each — the shape a real deployment has.
// They share `demo-app/` as their source tree, so each gets its own per-run
// worktree of it; that is what keeps a repair to one service's file from
// travelling into another service's checkout, and what makes the run's Changes
// tab group repairs by the service that needed them.
const appDir = path.join(__dirname, '..', '..', 'demo-app')

const config = {
  name: 'storefront_journey',
  description: 'A customer buys two in-stock catalog items with a welcome discount.',
  envs: ['local'],
  // One failure per cycle, so a repair agent sees exactly one broken contract
  // and each repair reveals the next. This is the knob that decides it: it
  // becomes `--max-failures=1` on the Playwright command line, which OVERRIDES
  // `maxFailures` in playwright.config.ts. Left at the default 2, two journeys
  // fail together and the chain stops being a chain.
  healOnFailureThreshold: 1,
  repos: [
    {
      name: 'catalog-service',
      localPath: appDir,
      startCommands: [
        {
          name: 'catalog-service',
          command: 'npm run dev:catalog',
          ports: [{ name: 'catalog', env: 'PORT' }],
          healthCheck: { http: { url: 'http://localhost:${port.catalog}/' } },
        },
      ],
    },
    {
      name: 'inventory-service',
      localPath: appDir,
      startCommands: [
        {
          name: 'inventory-service',
          command: 'npm run dev:inventory',
          ports: [{ name: 'inventory', env: 'PORT' }],
          healthCheck: { http: { url: 'http://localhost:${port.inventory}/' } },
        },
      ],
    },
    {
      name: 'checkout-service',
      localPath: appDir,
      startCommands: [
        {
          // No port slot on purpose: this service hardcodes 4300, so two runs
          // of it at once collide. Making it injectable is the concurrency-prep
          // stage's job, and the demo leaves that work for it to do.
          name: 'checkout-service',
          command: 'npm run dev:checkout',
          healthCheck: { http: { url: 'http://localhost:4300/' } },
        },
      ],
    },
  ],
  featureDir: __dirname,
}

module.exports = { config }
