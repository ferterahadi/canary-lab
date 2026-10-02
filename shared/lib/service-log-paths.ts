export function serviceLogsFromManifest(manifest: { serviceLogs?: string[]; services?: Array<{ logPath?: string }> }): string[] {
  const legacy = Array.isArray(manifest.serviceLogs) ? manifest.serviceLogs : []
  const current = Array.isArray(manifest.services)
    ? manifest.services
        .map((s) => s.logPath)
        .filter((p): p is string => typeof p === 'string' && p.length > 0)
    : []
  return [...legacy, ...current]
}

