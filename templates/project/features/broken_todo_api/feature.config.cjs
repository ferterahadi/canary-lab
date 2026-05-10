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
          // Single-env feature — pick one transport. `http` is best when
          // the service has a usable root URL; switch to
          // `{ tcp: { port: 4100 } }` for raw TCP servers.
          healthCheck: { http: { url: 'http://localhost:4100/', timeoutMs: 3000 } },
        },
      ],
    },
  ],
  featureDir: __dirname,
}

module.exports = { config }
