# Canary Storefront — the one full-Flight demo

This is a deliberately small, un-onboarded product repository. There is no
prebuilt feature under `features/`: the demo begins before Repo scan so a tester
can watch Canary Lab conduct the complete Flight instead of opening a suite that
has already skipped half the journey.

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

## Start the interactive demo

From the Canary Lab source checkout, run:

```bash
npm run demo
```

The command creates a fresh persistent workspace, initializes this folder as
its own product git repository, starts Canary Lab, and prints a link to the
new-Flight dialog. It does not start a Flight or heal anything. Use the
repository path and intent printed in the terminal, then control every stage
from the UI.

The full Flight must cover Repo scan, Suite setup, Requirements, Test authoring
and coverage, Parallel readiness, Test Run and iterative healing, and Evaluation
Report. Agent timelines, service logs, captured changes, and the Journal remain
in the workspace after the server stops.

## Service commands

- `npm run dev:catalog` — catalog API; reads `PORT` (standalone default 4200).
- `npm run dev:inventory` — inventory API; reads `PORT` (standalone default 4400).
- `npm run dev:checkout` — checkout API; initially binds 4300 directly so the
  Parallel readiness stage has a real concurrency issue to correct.

This repository is training material, not a dependency. Delete `demo-app/`
after the tour when you are ready to point Flights at your own product repos.
