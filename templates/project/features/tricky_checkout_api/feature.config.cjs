const config = {
  name: 'tricky_checkout_api',
  description: 'Checkout API with four subtle bugs (rounding, case-sensitivity, accumulator, status code) for stress-testing the self-healing loop.',
  envs: ['local'],
  repos: [
    {
      name: 'tricky_checkout_api',
      localPath: __dirname,
      startCommands: [
        {
          name: 'tricky-checkout-api-server',
          command: 'npx tsx scripts/server.ts',
          healthCheck: {
            url: 'http://localhost:4200/',
            timeoutMs: 3000,
          },
        },
      ],
    },
  ],
  featureDir: __dirname,
}

module.exports = { config }
