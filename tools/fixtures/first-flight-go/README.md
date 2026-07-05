# first-flight-go

Tiny Go notes API used as the Canary Lab **Flight** non-web-stack E2E fixture
(R8: prove the pipeline holds for a repo with no package.json, no npm scripts,
no lockfile).

## Requirements

- The service reads its port from the `PORT` environment variable (a `-port`
  flag overrides it) and reports readiness on `GET /health`.
- It must refuse to start without an `AUTH_TOKEN` (provided via `.env`).
- `POST /notes` with a JSON `{ "title": "..." }` creates a note and returns it
  with an id (`201`).
- `POST /notes` without a title is rejected with `400`.
- `GET /notes` lists every created note — a note created via `POST /notes`
  must appear in the very next `GET /notes` response.

## Run

```bash
go run .   # no dependencies to fetch
```

Note: the shipped `main.go` carries a deliberate bug on the create→list path
(created notes are never appended). It exists so the flight's run→heal stage
has something real to fix.

Before flying it, `git init` + commit a copy — portify rejects a non-git repo
(same as the Node fixture).
