import { loadFeatureEnv } from '../../shared/configs/loadEnv'
loadFeatureEnv(__dirname + '/..')

export const GATEWAY_URL = process.env.GATEWAY_URL ?? 'http://localhost:4000'
