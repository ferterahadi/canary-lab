export function testLogicalKey(entry: { title: string; titlePath?: readonly string[] }): string | undefined {
  return entry.titlePath?.length ? [...entry.titlePath, entry.title].join('\u001f') : undefined
}
