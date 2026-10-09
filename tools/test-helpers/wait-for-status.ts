export async function waitForStatus(
  store: { get(id: string): { status: string } | null | undefined },
  id: string,
  until: readonly string[],
  timeoutMs = 8000,
  intervalMs = 20,
): Promise<string> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const record = store.get(id)
    if (record && until.includes(record.status)) return record.status
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  return store.get(id)?.status ?? 'missing'
}
