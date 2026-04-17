const config = {
  name: 'broken_todo_api',
  description: 'Intentionally broken sample feature with mixed passing and failing tests for self-fixing practice.',
  envs: ['local'],
  repos: [
    {
      name: 'broken_todo_api',
      localPath: __dirname,
      startCommands: [
        {
          name: 'broken-todo-api-server',
          command: 'npx tsx scripts/server.ts',
          healthCheck: {
            url: 'http://localhost:4100/',
            timeoutMs: 3000,
          },
        },
      ],
    },
  ],
  featureDir: __dirname,
}

module.exports = { config }
