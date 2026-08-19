const path = require('node:path')

const appDir = path.join(__dirname, '..', '..', 'workflow-app')

const config = {
  name: 'workflow-workbench',
  description:
    'Prove the service is healthy and greets a named user. The greeting requirement '
    + 'is intentionally uncovered so Coverage and Author have a real gap to expose.',
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
