const config = {
  name: 'example_todo_api',
  description: 'Working sample feature for Canary Lab.',
  envs: ['local', 'production'],
  repos: [
    {
      name: 'example_todo_api',
      localPath: __dirname,
      startCommands: [
        {
          name: 'example-todo-api-server',
          command: 'npx tsx scripts/server.ts',
          // Only boot the local server when running in `local`. Selecting
          // `production` skips startup and the production envset points
          // GATEWAY_URL at the remote URL instead.
          envs: ['local'],
          healthCheck: {
            url: 'http://localhost:4000/',
            timeoutMs: 3000,
          },
        },
      ],
    },
  ],
  featureDir: __dirname,
}

module.exports = { config }
