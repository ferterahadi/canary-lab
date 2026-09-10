import fs from 'fs'
import path from 'path'

// The ten scripted repairs of the shipped storefront demo (templates/project/
// demo-app), one per seeded heal defect, in the order the five journeys expose
// them. Two consumers: `smoke:demo` applies one per heal cycle as the LLM-free
// stand-in for a repair agent, and `tools/robustness-trials/` applies all ten
// at once to build the GREEN app the perturbation trials run against. One
// home, so the trials fixture can never drift from what the heal demo repairs.

export function replaceOnce(filePath, find, replacement) {
  const source = fs.readFileSync(filePath, 'utf-8')
  if (!source.includes(find)) {
    throw new Error(`scripted repair no longer matches ${filePath} — the canonical demo drifted`)
  }
  fs.writeFileSync(filePath, source.replace(find, replacement))
}

// The ten defects, in the order the five journeys expose them. Each entry is
// the LLM-free stand-in for one heal cycle: wait for a cycle whose failures
// INCLUDE the one it names, patch exactly one application file, signal a rerun.
// Order is load-bearing — it is the contract order in demo-app/REQUIREMENTS.md.
//
// Deliberately one repair per cycle even though `healOnFailureThreshold: 4` now
// reports up to four failing journeys at once. A real agent may fix several per
// cycle; this gate fixes one so a failure here names a single defect instead of
// a batch, which is what keeps a timeout diagnosable.
export const repairSteps = [
  {
    service: 'catalog-service',
    expectedFailure: 'espresso_beans',
    hypothesis: 'Catalog emits an underscore SKU, so inventory cannot consume the product identity contract.',
    fixDescription: 'Normalize whitespace in catalog SKUs to hyphens.',
    apply: (worktree) => replaceOnce(
      path.join(worktree, 'catalog-service', 'server.ts'),
      ".replace(/\\s+/g, '_')",
      ".replace(/\\s+/g, '-')",
    ),
  },
  {
    service: 'inventory-service',
    expectedFailure: 'Received: 42',
    hypothesis: 'Inventory adds reservations to available stock instead of subtracting them.',
    fixDescription: 'Calculate available stock as on-hand minus reserved.',
    apply: (worktree) => replaceOnce(
      path.join(worktree, 'inventory-service', 'server.ts'),
      'item.onHand + item.reserved',
      'item.onHand - item.reserved',
    ),
  },
  {
    service: 'checkout-service',
    expectedFailure: 'Received: 3600',
    hypothesis: 'Checkout records the discount but still returns the undiscounted subtotal.',
    fixDescription: 'Apply discountPercent when calculating the cart total.',
    apply: (worktree) => replaceOnce(
      path.join(worktree, 'checkout-service', 'server.ts'),
      'const total = (cart: Cart): number => subtotal(cart)',
      'const total = (cart: Cart): number => Math.round(subtotal(cart) * (100 - cart.discountPercent) / 100)',
    ),
  },
  {
    service: 'checkout-service',
    expectedFailure: 'Received: 1440',
    hypothesis: 'A second discount code is added to the first instead of replacing it.',
    fixDescription: 'Assign the new discount percentage rather than accumulating it.',
    apply: (worktree) => replaceOnce(
      path.join(worktree, 'checkout-service', 'server.ts'),
      'cart.discountPercent += percent',
      'cart.discountPercent = percent',
    ),
  },
  {
    service: 'inventory-service',
    expectedFailure: 'Received: 120',
    hypothesis: 'The oversell refusal reports on-hand stock instead of what is still available.',
    fixDescription: 'Report the available count in the 409 body.',
    apply: (worktree) => replaceOnce(
      path.join(worktree, 'inventory-service', 'server.ts'),
      "res.end(JSON.stringify({ error: 'not enough stock', available: item.onHand }))",
      "res.end(JSON.stringify({ error: 'not enough stock', available: available(item) }))",
    ),
  },
  {
    service: 'inventory-service',
    expectedFailure: 'Received: 400',
    hypothesis: 'Reserving an unknown SKU is reported as a malformed request instead of a missing resource.',
    fixDescription: 'Return 404 when the SKU does not exist.',
    apply: (worktree) => replaceOnce(
      path.join(worktree, 'inventory-service', 'server.ts'),
      "    if (!item) {\n      res.writeHead(400)\n      res.end(JSON.stringify({ error: 'unknown sku' }))",
      "    if (!item) {\n      res.writeHead(404)\n      res.end(JSON.stringify({ error: 'unknown sku' }))",
    ),
  },
  {
    service: 'catalog-service',
    expectedFailure: 'Received: 1800',
    hypothesis: 'A catalog price update is accepted but never applied to the product.',
    fixDescription: 'Persist priceCents on PATCH.',
    apply: (worktree) => replaceOnce(
      path.join(worktree, 'catalog-service', 'server.ts'),
      '      if (patch.name !== undefined) product.name = patch.name\n',
      '      if (patch.name !== undefined) product.name = patch.name\n      if (patch.priceCents !== undefined) product.priceCents = patch.priceCents\n',
    ),
  },
  {
    service: 'checkout-service',
    expectedFailure: 'Received: 4000',
    hypothesis: 'Reading a cart returns the undiscounted subtotal, disagreeing with what checkout charges.',
    fixDescription: 'Return the discounted total when reading a cart.',
    apply: (worktree) => replaceOnce(
      path.join(worktree, 'checkout-service', 'server.ts'),
      'res.end(JSON.stringify({ ...cart, total: subtotal(cart) }))',
      'res.end(JSON.stringify({ ...cart, total: total(cart) }))',
    ),
  },
  {
    service: 'catalog-service',
    expectedFailure: 'Received: true',
    hypothesis: 'Delete removes the entry after the matched one, so the requested product survives.',
    fixDescription: 'Splice at the matched index.',
    apply: (worktree) => replaceOnce(
      path.join(worktree, 'catalog-service', 'server.ts'),
      'products.splice(index + 1, 1)',
      'products.splice(index, 1)',
    ),
  },
  {
    service: 'checkout-service',
    expectedFailure: 'Received: 2000',
    hypothesis: 'A rejected discount code wipes the discount already on the cart.',
    fixDescription: 'Leave the live discount untouched when refusing an unknown code.',
    apply: (worktree) => replaceOnce(
      path.join(worktree, 'checkout-service', 'server.ts'),
      '        cart.discountPercent = 0\n        res.writeHead(400)',
      '        res.writeHead(400)',
    ),
  },
]
