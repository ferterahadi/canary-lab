import path from 'path'
import { getProjectRoot, getFeaturesDir } from '../runtime/project-root'

export const ROOT = getProjectRoot()
export const FEATURES_DIR = getFeaturesDir()
export const LOGS_DIR = path.join(ROOT, 'logs')
export const BENCHMARK_DIR = path.join(LOGS_DIR, 'benchmark')
export const PIDS_DIR = path.join(LOGS_DIR, 'pids')
export const MANIFEST_PATH = path.join(LOGS_DIR, 'manifest.json')
export const SUMMARY_PATH = path.join(LOGS_DIR, 'e2e-summary.json')
export const PLAYWRIGHT_STDOUT_PATH = path.join(LOGS_DIR, 'playwright-stdout.log')
export const HEAL_INDEX_PATH = path.join(LOGS_DIR, 'heal-index.md')
export const FAILED_DIR = path.join(LOGS_DIR, 'failed')

// Resolved at call time so baseline mode can redirect the summary out of
// LOGS_DIR (and the workspace entirely) by setting CANARY_LAB_SUMMARY_PATH.
// The runner still needs the summary for failure-signature detection, but
// baseline wants a clean LOGS_DIR — the reporter writes to tmpdir instead.
export function getSummaryPath(): string {
  return process.env.CANARY_LAB_SUMMARY_PATH ?? SUMMARY_PATH
}
export const DIAGNOSIS_JOURNAL_PATH = path.join(LOGS_DIR, 'diagnosis-journal.md')
export const RERUN_SIGNAL = path.join(LOGS_DIR, '.rerun')
export const RESTART_SIGNAL = path.join(LOGS_DIR, '.restart')
export const HEAL_SIGNAL = path.join(LOGS_DIR, '.heal')
export const SIGNAL_HISTORY_PATH = path.join(LOGS_DIR, 'signal-history.json')
export const ITERM_SESSION_IDS_PATH = path.join(LOGS_DIR, 'iterm-session-ids.json')
export const ITERM_HEAL_SESSION_IDS_PATH = path.join(LOGS_DIR, 'iterm-heal-session-ids.json')
