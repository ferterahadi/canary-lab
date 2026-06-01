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
          // Canary Lab allocates a free port per run and injects it as PORT so
          // two runs of this app don't clash. Reference it elsewhere via
          // `${port.api}` (resolved at boot). The server reads process.env.PORT
          // (falling back to 4100 when run standalone).
          ports: [{ name: 'api', env: 'PORT' }],
          // Single-env feature — pick one transport. `http` is best when
          // the service has a usable root URL; switch to
          // `{ tcp: { port: 4100 } }` for raw TCP servers.
          healthCheck: { http: { url: 'http://localhost:${port.api}/', timeoutMs: 3000 } },
        },
      ],
    },
  ],
  featureDir: __dirname,
}

module.exports = { config }
