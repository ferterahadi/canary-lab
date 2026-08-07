# Canary Storefront — the repair-loop demo

A deliberately small product repository that **ships with its suite already
written**: `features/storefront_journey/`. Open it, press Run, and watch the
repair loop work — every journey starts broken, and each repair reveals the next
defect until the suite is green.

For the other half of the product — Canary Lab authoring a suite from nothing —
see `flight-app/`, which ships with no suite at all so a Flight has something to
onboard.

The repository contains one customer flow across three services:

```text
catalog-service → inventory-service → checkout-service
 product + SKU       reservation        final total
```

The public acceptance contract is in [REQUIREMENTS.md](REQUIREMENTS.md). It is
deliberately limited to one happy-path journey: create `Espresso Beans`, reserve
two units, and apply `WELCOME10`. The API's other validation responses make the
fixture realistic but are not part of this demo feature. Its checks are
intentionally dependent: catalog must produce the right SKU before inventory
can prove its reservation, and inventory must succeed before checkout can prove
the total.

The services contain one defect at each layer. They are not labelled in source;
the current failure is the evidence a repair agent should act on. Once that fix
passes, the next layer becomes observable on the following run. A successful
demo therefore leaves separate Journal entries and application changes under
all three service directories.

## Start the demo

From a scaffolded workspace, `npx canary-lab ui`, then open the
`storefront_journey` suite and press **Run**.

From the Canary Lab source checkout, `npm run demo` does the same thing the long
way round: it packs the current build, runs the real `canary-lab init`, and opens
the UI — so a contributor sees exactly what a user sees. It starts nothing; every
run and repair is yours to trigger.

## Service commands

- `npm run dev:catalog` — catalog API; reads `PORT` (standalone default 4200).
- `npm run dev:inventory` — inventory API; reads `PORT` (standalone default 4400).
- `npm run dev:checkout` — checkout API; initially binds 4300 directly so the
  Parallel readiness stage has a real concurrency issue to correct.

This repository is training material, not a dependency. Delete `demo-app/`
after the tour when you are ready to point Flights at your own product repos.
