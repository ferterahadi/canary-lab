import axios, { AxiosResponse } from 'axios'
import { v4 as uuidv4 } from 'uuid'
import {
  AUTH_ENTITY_ID,
  AUTH_ENTITY_TYPE,
  AUTH_FROM_EMAIL,
  AUTH_TRANSACTION_TYPE,
  GATEWAY_URL,
} from '../../src/config'

const nowId = () => Date.now().toString(36)

export interface SentEmail {
  messageId: string
  transactionId: string
}

export async function sendEmail(): Promise<SentEmail> {
  const transactionId = `auth-test-${uuidv4()}`
  const messageId = `auth-msg-${nowId()}-${Math.random().toString(36).slice(2, 8)}`

  const resp = await axios.post(
    `${GATEWAY_URL}/v1/email/single`,
    {
      from: AUTH_FROM_EMAIL,
      transactionId,
      transactionType: AUTH_TRANSACTION_TYPE,
      content: {
        messageId,
        to: 'canary-auth-test@oddle.me',
        subject: 'cns_better_auth canary test',
        body: '<p>Auth enforcement test.</p>',
        metadata: { isSendTest: true },
      },
    },
    { validateStatus: () => true },
  )

  if (resp.status !== 200 && resp.status !== 201) {
    throw new Error(
      `sendEmail failed (${resp.status}): ${JSON.stringify(resp.data)}`,
    )
  }

  return { messageId, transactionId }
}

type ReadOpts = {
  authKey?: string
  adminKey?: string
}

function buildAuthHeaders(opts: ReadOpts): Record<string, string> {
  if (opts.adminKey) return { 'admin-api-key': opts.adminKey }
  if (opts.authKey) {
    const bearer = opts.authKey.startsWith('Bearer ')
      ? opts.authKey
      : `Bearer ${opts.authKey}`
    return { Authorization: bearer }
  }
  return {}
}

export async function getEmailV2(
  messageId: string,
  transactionId: string,
  opts: ReadOpts = {},
): Promise<AxiosResponse> {
  return axios.get(`${GATEWAY_URL}/v2/email/${messageId}`, {
    params: {
      'entity-id': AUTH_ENTITY_ID,
      'entity-type': AUTH_ENTITY_TYPE,
      'transaction-id': transactionId,
    },
    headers: buildAuthHeaders(opts),
    validateStatus: () => true,
  })
}

export async function getEmailV1(
  messageId: string,
  transactionId: string,
  opts: ReadOpts = {},
): Promise<AxiosResponse> {
  return axios.get(`${GATEWAY_URL}/v1/email/${messageId}`, {
    params: {
      'entity-id': AUTH_ENTITY_ID,
      'entity-type': AUTH_ENTITY_TYPE,
      'transaction-id': transactionId,
    },
    headers: buildAuthHeaders(opts),
    validateStatus: () => true,
  })
}
