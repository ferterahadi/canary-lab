export const baseConfig = {
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  // Playwright's ReporterDescription tuple does not narrow from a literal, and
  // this file is a published export (canary-lab/feature-support/playwright-base),
  // so retyping it is a semver decision rather than a lint fix.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  reporter: [['list'] as any],
  timeout: 90_000,
  use: {
    trace: 'retain-on-failure' as const,
    screenshot: 'only-on-failure' as const,
  },
}
