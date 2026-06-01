# Canary Lab AI Agent Promo

Durable Remotion source for the 24 second, 1920x1080 promo in:

- `docs/assets/canary-lab-ai-agent-promo.webm`
- `docs/assets/canary-lab-repair-loop.gif`

## Render

```sh
npm run promo:agent:render
```

That command first captures the real Canary Lab React UI with mocked promo data, then renders the WebM and GIF from the captured frames.

Useful pieces:

```sh
npm run promo:agent:capture
npm run promo:agent:render:webm
npm run promo:agent:render:gif
```

If Chromium is not discovered automatically, set:

```sh
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH="/path/to/Google Chrome for Testing"
```

The capture frames are generated under `public/live-app/` and intentionally ignored by git.
