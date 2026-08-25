# first-flight-app

Tiny todo API used as the Canary Lab **Flight** E2E fixture.

## Requirements

- The service reads its port from the `PORT` environment variable and reports
  readiness on `GET /health`.
- It must refuse to start without an `API_TOKEN` (provided via `.env`).
- `POST /todos` with a JSON `{ "title": "..." }` creates a todo and returns it
  with an id (`201`).
- `POST /todos` without a title is rejected with `400`.
- `GET /todos` lists every created todo — an item created via `POST /todos`
  must appear in the very next `GET /todos` response.

## Run

```bash
npm run dev   # node server.js — no dependencies to install
```

`server.js` deliberately fails the create→list path by not storing todos, giving
Flight's run→heal stage a real defect.
