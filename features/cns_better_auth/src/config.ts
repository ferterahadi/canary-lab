import path from 'node:path'
import { config as loadDotenv } from 'dotenv'

loadDotenv({ path: path.join(__dirname, '..', '.env') })

export const GATEWAY_URL = process.env.GATEWAY_URL ?? 'http://localhost:3000'

export const AUTH_FROM_EMAIL = process.env.AUTH_FROM_EMAIL ?? ''
export const AUTH_ENTITY_ID = process.env.AUTH_ENTITY_ID ?? ''
export const AUTH_ENTITY_TYPE = process.env.AUTH_ENTITY_TYPE ?? 'BRAND'
export const AUTH_TRANSACTION_TYPE =
  process.env.AUTH_TRANSACTION_TYPE ?? 'AUTH_TEST'

export const AUTH_MISMATCH_KEY = process.env.AUTH_MISMATCH_KEY ?? ''

export const ADMIN_KEY = process.env.ADMIN_KEY ?? ''

export function requireAuthEnv(): void {
  const missing: string[] = []
  if (!AUTH_FROM_EMAIL) missing.push('AUTH_FROM_EMAIL')
  if (!AUTH_ENTITY_ID) missing.push('AUTH_ENTITY_ID')
  if (!ADMIN_KEY) missing.push('ADMIN_KEY')

  if (missing.length > 0) {
    throw new Error(
      `Missing required cns_better_auth env vars: ${missing.join(', ')}\n` +
        `Set them in features/cns_better_auth/.env before running.`,
    )
  }
}
