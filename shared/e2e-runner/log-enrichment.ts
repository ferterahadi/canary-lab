import fs from 'fs'
import path from 'path'
import { MANIFEST_PATH, SUMMARY_PATH } from './paths'

export function extractLogsForTest(
  slug: string,
  serviceLogs: string[],
): Record<string, string> {
  const logs: Record<string, string> = {}
  const openTag = `<${slug}>`
  const closeTag = `</${slug}>`

  for (const logPath of serviceLogs) {
    if (!fs.existsSync(logPath)) continue
    const content = fs.readFileSync(logPath, 'utf-8')
    const openIdx = content.indexOf(openTag)
    const closeIdx = content.indexOf(closeTag)
    if (openIdx === -1 || closeIdx === -1 || closeIdx <= openIdx) continue
    const snippet = content
      .slice(openIdx + openTag.length, closeIdx)
      .trim()
    if (snippet.length > 0) {
      const svcName = path.basename(logPath, '.log')
      logs[svcName] = snippet
    }
  }
  return logs
}

export function enrichSummaryWithLogs(): void {
  if (!fs.existsSync(SUMMARY_PATH) || !fs.existsSync(MANIFEST_PATH)) return

  const summary = JSON.parse(fs.readFileSync(SUMMARY_PATH, 'utf-8'))
  const manifest: { serviceLogs: string[] } = JSON.parse(
    fs.readFileSync(MANIFEST_PATH, 'utf-8'),
  )

  if (!Array.isArray(summary.failed) || summary.failed.length === 0) return

  summary.failed = summary.failed.map(
    (entry: string | { name: string; [key: string]: unknown }) => {
      if (typeof entry === 'string') {
        return { name: entry, logs: extractLogsForTest(entry, manifest.serviceLogs) }
      }
      return { ...entry, logs: extractLogsForTest(entry.name, manifest.serviceLogs) }
    },
  )

  const tmpPath = `${SUMMARY_PATH}.tmp`
  fs.writeFileSync(tmpPath, JSON.stringify(summary, null, 2) + '\n')
  fs.renameSync(tmpPath, SUMMARY_PATH)
}
