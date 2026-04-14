import path from 'path'
import fs from 'fs'
import dotenv from 'dotenv'

/**
 * Load .env file from a feature directory. Call this at the top of
 * your feature's src/config.ts before exporting typed constants.
 */
export function loadFeatureEnv(featureDir: string): void {
  const envFile = path.join(featureDir, '.env')
  if (fs.existsSync(envFile)) {
    dotenv.config({ path: envFile })
  }
}
