import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['scripts/**/*.test.ts', 'shared/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: 'coverage',
      include: ['scripts/**/*.ts', 'shared/**/*.ts'],
      exclude: [
        '**/*.test.ts',
        '**/*.d.ts',
        'shared/configs/**',
        'shared/runtime/**',
      ],
    },
  },
})
