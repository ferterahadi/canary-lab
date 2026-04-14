import type { FeatureConfig } from '../../shared/launcher/types'

export const config: FeatureConfig = {
  name: 'example_todo_api',
  description: 'Example feature — TODO API CRUD tests (self-contained, no external repos)',
  envs: ['local'],
  repos: [
    {
      name: 'example_todo_api',
      localPath: __dirname,
      startCommands: [
        {
          name: 'todo-api-server',
          command: 'npx tsx scripts/server.ts',
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
