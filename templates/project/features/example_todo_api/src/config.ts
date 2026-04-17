import path from 'node:path'
import { config as loadDotenv } from 'dotenv'

loadDotenv({ path: path.join(__dirname, '..', '.env') })

export const GATEWAY_URL = process.env.GATEWAY_URL ?? 'http://localhost:4000'
