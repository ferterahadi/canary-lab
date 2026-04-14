export const baseConfig = {
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'] as any],
  timeout: 90_000,
  use: {
    trace: 'retain-on-failure' as const,
    screenshot: 'only-on-failure' as const,
  },
}
