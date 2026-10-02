export interface ActivityIdentity {
  id: string
  source: string
  sequence: number
  timestamp?: string
}

export function activityTime(timestamp: string | undefined): number | null {
  const time = Date.parse(timestamp ?? '')
  return Number.isFinite(time) ? time : null
}

/** Sort a copy: source order is also the snapshot/WebSocket replay cursor. */
export function chronologicalActivity<T extends ActivityIdentity>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => {
    const left = activityTime(a.timestamp)
    const right = activityTime(b.timestamp)
    if (left === null && right !== null) return -1
    if (left !== null && right === null) return 1
    return (left !== null && right !== null ? left - right : 0)
      || a.source.localeCompare(b.source) || a.sequence - b.sequence || a.id.localeCompare(b.id)
  })
}

export function activityDate(timestamp: string | undefined): string {
  const time = activityTime(timestamp)
  return time === null ? 'Time unavailable' : new Date(time).toLocaleDateString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
  })
}
