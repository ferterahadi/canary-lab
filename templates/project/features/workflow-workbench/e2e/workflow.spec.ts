import { test, expect } from 'canary-lab/feature-support/log-marker-fixture'

const baseUrl = process.env.WORKFLOW_URL ?? 'http://localhost:4600'

test('the workflow service reports healthy', { tag: ['@req-R1', '@path-happy'] }, async ({ request }) => {
  const response = await request.get(`${baseUrl}/health`)
  expect(response.status()).toBe(200)
  await expect(response.json()).resolves.toEqual({ status: 'ok' })
})

// R2 is deliberately absent. The Author demo adds that journey; the Coverage
// demo must report it as untested until then.
