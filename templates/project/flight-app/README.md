# Canary Lending — the Flight demo

A small, **un-onboarded** product repository with no suite, built for watching
Canary Lab create one.

Point a Flight at this folder and it will conduct every stage:

```text
Repo scan → Suite setup → Requirements → Test authoring & coverage
          → Parallel readiness → Test Run & heal → Evaluation Report
```

Every stage has real work:

- **Repo scan** finds one service and its start command.
- **Requirements** reads [REQUIREMENTS.md](REQUIREMENTS.md) — three contracts.
- **Test authoring** writes the specs; nothing is pre-written.
- **Parallel readiness** fixes `lending-service` binding port 4500 directly.
- **Test Run & heal** finds an unlabeled defect from its failing assertion.
- **Evaluation Report** exports the archive.

For an existing failing suite, use `demo-app/` and `storefront-journey`.

## Service command

- `npm run dev:lending` — lending API, binds 4500 directly.

This is training material, not a dependency. Delete `flight-app/` after the tour.
