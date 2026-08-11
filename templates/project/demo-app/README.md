# Canary Storefront — the repair-loop demo

A deliberately small product repository that **ships with its suite already
written, its requirements distilled and its coverage at 100%**:
`features/storefront-journey/`. Everything an onboarded feature has is already
there — the only thing left undone is the run. Open it, press Run, and watch the
repair loop work: each repair reveals the next defect until the suite is green.

For the other half of the product — Canary Lab authoring a suite from nothing —
see `flight-app/`, which ships with no suite at all so a Flight has something to
onboard.

The repository contains one customer flow across three services:

```text
catalog-service → inventory-service → checkout-service
 product + SKU       reservation        final total
```

The public acceptance contract is in [REQUIREMENTS.md](REQUIREMENTS.md): seven
customer journeys covering twelve contracts. Five journeys are ordered pairs, so
the second contract is unreachable until the first passes. Two (J0 and J6) are
sound and pass from the very first run — a suite where everything fails cannot
show that the harness reports what it finds rather than repairing whatever it
touches.

Ten of the twelve contracts start broken, spread across all three services. The
defects are not labelled in source; the current failures are the only evidence a
repair agent should act on. A run stops once four journeys have failed and hands
that batch over, and because each journey is an ordered pair, repairing what a
cycle reports uncovers the contract behind it. A successful demo leaves Journal
entries and application changes under all three service directories.

## Start the demo

From a scaffolded workspace, `npx canary-lab ui`, then open the
`storefront-journey` suite and press **Run**.

From the Canary Lab source checkout, `npm run demo` does the same thing the long
way round: it packs the current build, runs the real `canary-lab init`, and opens
the UI — so a contributor sees exactly what a user sees. It starts nothing; every
run and repair is yours to trigger.

## Service commands

- `npm run dev:catalog` — catalog API; reads `PORT` (standalone default 4200).
- `npm run dev:inventory` — inventory API; reads `PORT` (standalone default 4400).
- `npm run dev:checkout` — checkout API; reads `PORT` (standalone default 4300).

All three read `PORT`, so the suite declares a slot per service and two copies
of this demo can heal side by side. (`flight-app/` is the one that hardcodes its
port — that repo is where the Parallel readiness stage has real work to do.)

This repository is training material, not a dependency. Delete `demo-app/`
after the tour when you are ready to point Flights at your own product repos.
