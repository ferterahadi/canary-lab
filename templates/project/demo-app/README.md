# Canary Storefront — the repair-loop demo

A small product repository with a finished, 100%-covered suite:
`features/storefront-journey/`. Press **Run** to watch each repair reveal the next
defect until the suite is green.

To watch Canary Lab build a suite from nothing, use the un-onboarded `flight-app/`.

The repository contains one customer flow across three services:

```text
catalog-service → inventory-service → checkout-service
 product + SKU       reservation        final total
```

[REQUIREMENTS.md](REQUIREMENTS.md) defines seven journeys and twelve contracts.
Five journeys are ordered pairs: the second contract appears only after the first
passes. J0 and J6 pass immediately, proving the harness does not repair every test.

Ten contracts start broken across all three services. Source does not label the
defects; current failures are the repair agent's evidence. A run hands over after
four failed journeys, and each repair cycle uncovers later contracts. A successful
demo leaves Journal entries and changes under all three service directories.

## Start the demo

From a scaffolded workspace, `npx canary-lab ui`, then open the
`storefront-journey` suite and press **Run**.

From the Canary Lab source checkout, `npm run demo` packs the build, runs the real
`canary-lab init`, and opens the shipped UI. It starts no run or repair.

## Service commands

- `npm run dev:catalog` — catalog API; reads `PORT` (standalone default 4200).
- `npm run dev:inventory` — inventory API; reads `PORT` (standalone default 4400).
- `npm run dev:checkout` — checkout API; reads `PORT` (standalone default 4300).

All three read `PORT`, so two demos can heal side by side. `flight-app/` instead
hardcodes its port to give Parallel readiness real work.

This is training material, not a dependency. Delete `demo-app/` after the tour.
