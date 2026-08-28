export const READABLE_TEST_FIXTURE_CATEGORIES = [
  'playwright-calls',
  'helpers',
  'ambiguity',
  'control-flow',
] as const

export type ReadableTestFixtureCategory = typeof READABLE_TEST_FIXTURE_CATEGORIES[number]

export interface ReadableTestFixture {
  id: string
  file: string
  language: 'javascript' | 'typescript'
  testName: string
  categories: ReadableTestFixtureCategory[]
  source: string
}

export const READABLE_TEST_FIXTURES: ReadableTestFixture[] = [
  {
    id: 'javascript-playwright-calls',
    file: 'checkout.spec.js',
    language: 'javascript',
    testName: 'submits checkout',
    categories: ['playwright-calls'],
    source: `
import { test, expect } from '@playwright/test'

test('submits checkout', async ({ page, request }) => {
  await page.goto('/checkout')
  await page.getByLabel('Email').fill('ada@example.com')
  await page.getByRole('checkbox', { name: 'Terms' }).check()
  await page.getByRole('combobox', { name: 'Country' }).selectOption('SG')
  await page.getByRole('button', { name: 'Pay now' }).click()
  await page.waitForURL('/orders/confirmed')
  const response = await request.post('/api/orders', { data: { plan: 'team' } })
  await expect(page).toHaveURL('/orders/confirmed')
  await expect(page.getByText('Payment accepted')).toBeVisible()
  expect(response.status()).toBe(201)
})
`.trim(),
  },
  {
    id: 'typescript-authored-and-helper-steps',
    file: 'account.spec.ts',
    language: 'typescript',
    testName: 'updates an account',
    categories: ['playwright-calls', 'helpers'],
    source: `
import { test, expect, type Page } from '@playwright/test'
import { seedAccount } from './support/account-seed'

async function loginAs(page: Page, email: string): Promise<void> {
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill('secret')
  await page.getByRole('button', { name: 'Sign in' }).click()
}

test('updates an account', async ({ page }) => {
  await seedAccount('ada@example.com')
  await test.step('Sign in as the account owner', async () => {
    await loginAs(page, 'ada@example.com')
    await test.step('Open account settings', async () => {
      await page.getByRole('link', { name: 'Settings' }).click()
    })
  })
  await expect(page.getByTestId('account-name')).toHaveText('Ada')
})
`.trim(),
  },
  {
    id: 'typescript-control-flow',
    file: 'workflow.spec.ts',
    language: 'typescript',
    testName: 'handles workflow variants',
    categories: ['control-flow'],
    source: `
import { test, expect } from '@playwright/test'

test('handles workflow variants', async ({ page }) => {
  if (await page.getByText('Continue').isVisible()) {
    await page.getByText('Continue').click()
  } else {
    await page.getByText('Start').click()
  }

  switch (await page.getByTestId('state').textContent()) {
    case 'ready':
      await page.getByRole('button', { name: 'Run' }).click()
      break
    default:
      await page.reload()
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    await page.getByText('Retry').click()
  }
  for (const item of items) {
    if (!item.enabled) continue
    await page.getByText(item.label).click()
  }
  for await (const event of stream) {
    if (event.done) break
    await expect(page.getByText(event.message)).toBeVisible()
  }
  for (let retry = start; retry < limit; retry += step) {
    await page.reload()
  }
  while (await page.getByText('Pending').isVisible()) {
    await page.reload()
  }
  do {
    await page.getByText('Refresh').click()
  } while (await page.getByText('Stale').isVisible())
})
`.trim(),
  },
  {
    id: 'javascript-ambiguous-source',
    file: 'dynamic.spec.js',
    language: 'javascript',
    testName: 'uses runtime-selected behavior',
    categories: ['helpers', 'ambiguity'],
    source: `
import { test } from '@playwright/test'
import { runSelectedAction } from './runtime-actions'

test('uses runtime-selected behavior', async ({ page }) => {
  const method = process.env.ACTION
  await page[method](targetFromEnvironment())
  await runSelectedAction(page, configuration.steps)
})
`.trim(),
  },
]
