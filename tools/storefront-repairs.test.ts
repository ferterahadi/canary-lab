import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { repairSteps, replaceOnce } from './storefront-repairs.mjs'

// Pins the scripted repairs to the shipped template. `smoke:demo` proves them
// against a running run loop; this is the cheap half — every anchor matches the
// template once, so a template edit that moves one fails here in seconds.

const templateApp = path.resolve(import.meta.dirname, '..', 'templates', 'project', 'demo-app')
let appDir: string

beforeEach(() => {
  appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'storefront-repairs-'))
  fs.cpSync(templateApp, appDir, { recursive: true })
})

afterEach(() => {
  fs.rmSync(appDir, { recursive: true, force: true })
})

describe('repairSteps', () => {
  it('lists the ten heal defects, one application file each, in journey order across the three services', () => {
    expect(repairSteps).toHaveLength(10)
    expect(repairSteps.map((step) => step.service)).toEqual([
      'catalog-service', 'inventory-service', 'checkout-service', 'checkout-service', 'inventory-service',
      'inventory-service', 'catalog-service', 'checkout-service', 'catalog-service', 'checkout-service',
    ])
    for (const step of repairSteps) {
      expect(step.expectedFailure).toBeTruthy()
      expect(step.hypothesis).toBeTruthy()
      expect(step.fixDescription).toBeTruthy()
    }
  })

  it('turns a fresh copy of the shipped template into the green storefront', () => {
    for (const step of repairSteps) step.apply(appDir)
    const read = (svc: string) => fs.readFileSync(path.join(appDir, svc, 'server.ts'), 'utf8')
    const catalog = read('catalog-service')
    const inventory = read('inventory-service')
    const checkout = read('checkout-service')
    expect(catalog).toContain(".replace(/\\s+/g, '-')")
    expect(catalog).toContain('if (patch.priceCents !== undefined) product.priceCents = patch.priceCents')
    expect(catalog).toContain('products.splice(index, 1)')
    expect(inventory).toContain('item.onHand - item.reserved')
    expect(inventory).toContain("available: available(item)")
    expect(inventory).toContain("res.writeHead(404)\n      res.end(JSON.stringify({ error: 'unknown sku' }))")
    expect(checkout).toContain('Math.round(subtotal(cart) * (100 - cart.discountPercent) / 100)')
    expect(checkout).toContain('cart.discountPercent = percent')
    expect(checkout).not.toContain('total: subtotal(cart)')
    expect(checkout).not.toContain('cart.discountPercent = 0')
  })

  it('leaves the two sound journeys and the durability layer untouched', () => {
    const before = fs.readFileSync(path.join(appDir, 'shared', 'durable.ts'), 'utf8')
    for (const step of repairSteps) step.apply(appDir)
    expect(fs.readFileSync(path.join(appDir, 'shared', 'durable.ts'), 'utf8')).toBe(before)
  })
})

describe('replaceOnce', () => {
  it('replaces the first match and names the drifted file when there is none', () => {
    const file = path.join(appDir, 'probe.txt')
    fs.writeFileSync(file, 'a b a')
    replaceOnce(file, 'a', 'x')
    expect(fs.readFileSync(file, 'utf8')).toBe('x b a')
    expect(() => replaceOnce(file, 'zzz', 'y')).toThrow(`scripted repair no longer matches ${file} — the canonical demo drifted`)
  })
})
