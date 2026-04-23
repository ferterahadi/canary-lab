import path from 'path'
import fs from 'fs'
import dotenv from 'dotenv'

/**
 * Load a feature's `.env` file. Optional helper — the scaffold loads dotenv
 * directly from `playwright.config.ts` using raw `dotenv`, but this helper is
 * available for users who want the no-throw-when-missing behavior.
 */
export function loadFeatureEnv(featureDir: string): void {
  const envFile = path.join(featureDir, '.env')
  if (fs.existsSync(envFile)) {
    dotenv.config({ path: envFile })
  }
}
