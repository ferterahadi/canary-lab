const config = {
  name: 'example_todo_api',
  description: 'Working sample feature for Canary Lab.',
  envs: ['local'],
  repos: [
    {
      name: 'example_todo_api',
      localPath: __dirname,
      startCommands: [
        {
          name: 'example-todo-api-server',
          command: 'node scripts/server.js',
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
