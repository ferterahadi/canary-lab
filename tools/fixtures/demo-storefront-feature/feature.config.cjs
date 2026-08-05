const path = require('node:path')

const config = {
  name: 'storefront_journey',
  description: 'A customer buys two in-stock catalog items with a welcome discount.',
  envs: ['local'],
  repos: [
    {
      name: 'storefront',
      localPath: path.join(__dirname, '..', '..', 'demo-app'),
      startCommands: [
        {
          name: 'catalog-service',
          command: 'npm run dev:catalog',
          ports: [{ name: 'catalog', env: 'PORT' }],
          healthCheck: { http: { url: 'http://localhost:${port.catalog}/' } },
        },
        {
          name: 'inventory-service',
          command: 'npm run dev:inventory',
          ports: [{ name: 'inventory', env: 'PORT' }],
          healthCheck: { http: { url: 'http://localhost:${port.inventory}/' } },
        },
        {
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
