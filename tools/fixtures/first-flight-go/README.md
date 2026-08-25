# first-flight-go

Tiny Go notes API proving Canary Lab **Flight** works without `package.json`, npm
scripts, or a lockfile.

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

`main.go` deliberately fails create→list by not appending notes, giving Flight's
run→heal stage a real defect.

Before Flight, run `git init` and commit a copy; Portify rejects non-Git repos.
