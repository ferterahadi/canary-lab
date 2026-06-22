const config = {
  name: 'cns_better_auth',
  description: 'Service-scoped resource authorization for /v2 endpoints — callers may only read resources their own app created; admin bypass; v1 unaffected',
  envs: ['local'],
  repos: [
    {
      name: 'mighty-cns',
      localPath: '~/Documents/mighty-cns',
      cloneUrl: 'git@github.com:oddle-engineering/mighty-cns.git',
      startCommands: [
  {
    "command": "yarn start:all:dev",
    "name": "mighty-cns gateway stack",
    "healthCheck": {
      "http": {
        "url": "http://localhost:3000/health"
      }
    }
  }
]
    }
  ],
  featureDir: __dirname,
}

module.exports = { config }
