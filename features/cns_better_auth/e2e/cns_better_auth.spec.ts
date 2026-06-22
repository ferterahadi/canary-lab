import { test, expect } from 'canary-lab/feature-support/log-marker-fixture'
import { ADMIN_KEY, AUTH_MISMATCH_KEY, requireAuthEnv } from '../src/config'
import { getEmailV1, getEmailV2, sendEmail } from './helpers/cns'

test.describe('cns_better_auth', () => {
  let messageId: string
  let transactionId: string

  test.beforeAll(async () => {
    requireAuthEnv()
    const sent = await sendEmail()
    messageId = sent.messageId
    transactionId = sent.transactionId
  })

  test(
    'v2 match - canary bypass reads own message, app absent from response',
    { tag: ['@req-R1', '@path-happy'] },
    async () => {
      const resp = await getEmailV2(messageId, transactionId)
      expect(resp.status, 'should be 200 for matching app').toBe(200)
      const payload = resp.data?.data
      expect(payload, 'response body should have a data object').toBeTruthy()
      expect(payload?.app, 'app field must be stripped from the response').toBeUndefined()
      expect(payload?.messageId, 'messageId should be present').toBe(messageId)
    },
  )

  test(
    'v2 mismatch - different app credential gets 404',
    { tag: ['@req-R2', '@path-sad'] },
    async () => {
      if (!AUTH_MISMATCH_KEY) { test.skip(); return }
      const resp = await getEmailV2(messageId, transactionId, { authKey: AUTH_MISMATCH_KEY })
      expect(resp.status, 'mismatch should yield 404, not 403').toBe(404)
    },
  )

  test(
    'v2 admin bypass - admin can read any app message',
    { tag: ['@req-R3', '@path-happy'] },
    async () => {
      const resp = await getEmailV2(messageId, transactionId, { adminKey: ADMIN_KEY })
      expect(resp.status, 'admin should get 200').toBe(200)
      const payload = resp.data?.data
      expect(payload?.app, 'app field should also be stripped for admin').toBeUndefined()
    },
  )

  test(
    'v1 unaffected - different app credential still gets 200 on v1',
    { tag: ['@req-R4', '@path-happy'] },
    async () => {
      if (!AUTH_MISMATCH_KEY) { test.skip(); return }
      const resp = await getEmailV1(messageId, transactionId, { authKey: AUTH_MISMATCH_KEY })
      expect(resp.status, 'v1 should return 200 regardless of app').toBe(200)
    },
  )
})
