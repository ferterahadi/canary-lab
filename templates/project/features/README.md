# Features

This workspace ships one worked example so you can see what Canary Lab does
before pointing it at your own code:

- **`storefront_journey`** — a suite over the bundled `demo-app/` three-service
  storefront. Every journey starts broken on purpose. Press **Run** and watch the
  repair loop fix one service contract per cycle until the suite is green.

Delete it once you have seen it — it is a demonstration, not scaffolding you
need. Then add your own:

```bash
npx canary-lab new feature <name>
```

Or point a Flight at a product repository and let it author the suite for you,
from repo scan through evaluation export.
