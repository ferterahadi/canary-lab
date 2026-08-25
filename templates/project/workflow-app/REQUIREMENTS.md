# Workflow workbench requirements

## R1 — Service health

`GET /health` returns HTTP 200 with `{ "status": "ok" }`.

## R2 — Personalized greeting

`GET /greeting?name=Ada` returns HTTP 200 with `{ "message": "Hello, Ada!" }`.
The shipped suite intentionally has no test tagged `@req-R2`; this is the gap
the Coverage and Author demonstrations expose.
