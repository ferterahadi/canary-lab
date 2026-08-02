# Demo app — a tiny storefront

This is the product Canary Lab tests in your new workspace. It is deliberately
small, and where it is buggy the defects are planted so you can watch the repair
loop find and fix one.

Three services, each opening a different door into Canary Lab.

## `inventory-service` — already onboarded, and it works

`features/demo_inventory` points at this one, and its suite passes as shipped.
Run it first if you want to see what green looks like:

```
npx canary-lab ui
```

It is also what **Benchmark** scores agents against. A benchmark works by
sabotaging a service that works and checking the agent brings the suite back to
green — so it needs a subject that starts green. If you edit this service, keep
its tests passing.

## `catalog-service` — already onboarded

A feature (`features/demo_catalog`) already points at this service, so you can
run it the moment the installer finishes:

```
npx canary-lab ui
```

Pick **demo_catalog**, press Run. Two of its tests fail. If you have an agent
connected, the repair loop opens, edits `catalog-service/server.ts`, and reruns
until the suite is green. The diff it produced is on the run's **Changes** tab.

No agent installed? The run still executes and still reports the two failures —
you just fix them yourself.

## `checkout-service` — not onboarded yet

Nothing in `features/` points at this one, which is the point. Aim a flight at
it and Canary Lab builds the whole feature from scratch: reads the code, writes
the config, captures the environment, distills the requirements, writes the
specs, makes it safe to run concurrently, runs it, and repairs what fails.

```
npx canary-lab flight ./demo-app/checkout-service
```

This needs `claude` or `codex` on your PATH — the pipeline's stages are agent
work. It takes a while; the UI shows each stage as it lands.

Two things in `checkout-service` exist specifically to give the pipeline work to
do: its port is hardcoded (so the concurrency-prep stage has something to
change), and `REQUIREMENTS.md` is written as prose (so the requirements stage
has a real source to distill).

## Once you understand it, delete it

This app is scaffolding for the tour, not a dependency. Delete `demo-app/`,
`features/demo_catalog/` and `features/demo_inventory/` whenever you want to
start on your own code.
