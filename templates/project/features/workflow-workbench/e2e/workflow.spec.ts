import { test, expect } from 'canary-lab/feature-support/log-marker-fixture'

const baseUrl = process.env.WORKFLOW_URL ?? 'http://localhost:4600'

test('the workflow service reports healthy', async ({ request }) => {
  const response = await request.get(`${baseUrl}/health`)
  expect(response.status()).toBe(200)
  await expect(response.json()).resolves.toEqual({ status: 'ok' })
})

// The health test starts deliberately unlinked so the Coverage demo can map it
// to R1. R2 has no test at all; the Author demo adds that missing journey.
