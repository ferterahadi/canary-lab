export function runAsScript(meta: NodeModule, main: () => Promise<void>): void {
  if (require.main !== meta) return
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
