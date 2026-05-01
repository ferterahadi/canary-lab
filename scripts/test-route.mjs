import Fastify from 'fastify'
import { featuresRoutes } from './apps/web-server/routes/features.ts'

const app = Fastify()
await app.register(featuresRoutes, {
  featuresDir: '/Users/oddle/Documents/canary-lab-workspace/features',
})
const res = await app.inject({ method: 'GET', url: '/api/features/shop_redeeming_eats_voucher/tests' })
const body = res.json()
let total = 0
for (const file of body) {
  const base = file.file.split('/').pop()
  console.log(`\n${base}: ${file.tests.length} tests`)
  for (const t of file.tests) console.log(`  L${t.line}  ${t.name}`)
  total += file.tests.length
}
console.log(`\nTOTAL: ${total}`)
await app.close()
