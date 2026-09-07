import fs from 'fs'
import path from 'path'

// Static files the server ships beside its code and hands out verbatim — today
// the offline certificate checker the evaluation export bundles. Lives in
// `apps/web-server/assets/`, copied to `dist/apps/web-server/assets/` by
// `tools/prepare-assets.mjs` (same step as the prompts); this module is the one
// place that resolves the directory, mirroring `prompts.ts`.
export const ASSETS_DIR = path.resolve(__dirname, '../../assets')

export function readBundledAsset(name: string): string {
  const assetPath = path.join(ASSETS_DIR, name)
  if (!fs.existsSync(assetPath)) {
    throw new Error(`Bundled asset not found at ${assetPath}. Rebuild or reinstall canary-lab.`)
  }
  return fs.readFileSync(assetPath, 'utf-8')
}
