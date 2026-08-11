# Canary Lending — the Flight demo

A deliberately small, **un-onboarded** product repository. There is no suite for
it anywhere in this workspace, and that is the point: it exists so you can watch
Canary Lab build one.

Point a Flight at this folder and it will conduct every stage:

```text
Repo scan → Suite setup → Requirements → Test authoring & coverage
          → Parallel readiness → Test Run & heal → Evaluation Report
```

Each stage has real work to do here:

- **Repo scan** finds one service and its start command.
- **Requirements** reads [REQUIREMENTS.md](REQUIREMENTS.md) — three contracts.
- **Test authoring** writes the specs; nothing is pre-written.
- **Parallel readiness** has a genuine problem to fix: `lending-service` binds
  port 4500 directly, so two runs at once would collide.
- **Test Run & heal** has a genuine defect to find. It is not labelled in
  source; the failing assertion is the evidence.
- **Evaluation Report** exports the archive.

For the repair loop on its own — a suite that already exists, failing on the
first Run — see `demo-app/` and its `storefront-journey` suite instead.

## Service command

- `npm run dev:lending` — lending API, binds 4500 directly.

Training material, not a dependency. Delete `flight-app/` once you have taken
the tour and are ready to point Flights at your own repositories.
