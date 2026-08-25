const path = require('node:path')

const appDir = path.join(__dirname, '..', '..', 'workflow-app')

const config = {
  name: 'workflow-workbench',
  description:
    'Prove the service is healthy and greets a named user. The health test starts '
    + 'unmapped and the greeting test is absent, so Coverage and Author each have real work.',
  envs: ['local', 'production'],
  repos: [
    {
      name: 'workflow-app',
      localPath: appDir,
      startCommands: [
        {
          name: 'workflow-app',
          command: 'npm run dev',
          envs: ['local'],
          healthCheck: {
            local: { http: { url: 'http://localhost:4600/health' } },
            production: { http: { url: 'https://replace.invalid/health' } },
          },
        },
      ],
    },
  ],
  featureDir: __dirname,
}

module.exports = { config }
