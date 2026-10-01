import { ContainerGuardian } from '../container-guardian'

async function main(): Promise<void> {
  const guardian = new ContainerGuardian(JSON.parse(process.argv[2]))
  await guardian.run(['create'], 30_000)
  setInterval(() => {}, 1000)
}

main().catch((error) => { process.stderr.write(String(error)); process.exitCode = 1 })
