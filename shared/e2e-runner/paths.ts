import path from 'path'

export const ROOT = path.resolve(__dirname, '../..')
export const FEATURES_DIR = path.join(ROOT, 'features')
export const LOGS_DIR = path.join(ROOT, 'logs')
export const PIDS_DIR = path.join(LOGS_DIR, 'pids')
export const MANIFEST_PATH = path.join(LOGS_DIR, 'manifest.json')
export const SUMMARY_PATH = path.join(LOGS_DIR, 'e2e-summary.json')
export const RERUN_SIGNAL = path.join(LOGS_DIR, '.rerun')
export const RESTART_SIGNAL = path.join(LOGS_DIR, '.restart')
