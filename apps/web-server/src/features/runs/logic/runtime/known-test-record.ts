export interface KnownTestFields {
  name: string
  title: string
  titlePath?: string[]
  listLine?: string
  location?: string
}

/** Identity and collection merging belong to the reporter/rerun adapters. */
export function normalizeKnownTestRecord(entry: unknown): { id?: string; fields: KnownTestFields } | undefined {
  if (!entry || typeof entry !== 'object') return undefined
  const value = entry as Record<string, unknown>
  if (typeof value.name !== 'string' || value.name.length === 0) return undefined
  if (typeof value.title !== 'string' || value.title.length === 0) return undefined
  return {
    ...(typeof value.id === 'string' && value.id.length > 0 ? { id: value.id } : {}),
    fields: {
      name: value.name,
      title: value.title,
      ...(Array.isArray(value.titlePath)
        ? { titlePath: value.titlePath.filter((part): part is string => typeof part === 'string' && part.length > 0) }
        : {}),
      ...(typeof value.listLine === 'string' && value.listLine.length > 0 ? { listLine: value.listLine } : {}),
      ...(typeof value.location === 'string' && value.location.length > 0 ? { location: value.location } : {}),
    },
  }
}
