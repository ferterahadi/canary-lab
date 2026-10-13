import crypto from 'crypto'

export function coverageJsonDigest(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')
}
