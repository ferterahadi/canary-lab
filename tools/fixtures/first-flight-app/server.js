// First Flight fixture app: a dependency-free todo API.
//
// Contracts the flight exercises:
//   - Reads PORT from the environment (native port injection — portify's
//     zero-edit fast path).
//   - Refuses to boot without API_TOKEN (exercises env capture; the value
//     ships in the sibling .env file).
//   - GET /health is the readiness probe.
//   - DELIBERATE BUG for the heal loop: POST /todos acknowledges the item but
//     never stores it, so GET /todos stays empty. A correct E2E spec on the
//     create→list path fails until the heal agent adds the missing push.

const http = require('http')
const fs = require('fs')
const path = require('path')

// Load .env from the app dir (no dotenv dep — keep the fixture install-free).
try {
  const raw = fs.readFileSync(path.join(__dirname, '.env'), 'utf-8')
  for (const line of raw.split('\n')) {
    const eq = line.indexOf('=')
    if (eq > 0 && !line.trimStart().startsWith('#')) {
      const key = line.slice(0, eq).trim()
      if (!(key in process.env)) process.env[key] = line.slice(eq + 1).trim()
    }
  }
} catch { /* env may come from the environment instead */ }

if (!process.env.API_TOKEN) {
  console.error('API_TOKEN is required (set it in .env) — refusing to start.')
  process.exit(1)
}

const todos = []

const server = http.createServer((req, res) => {
  const send = (code, body) => {
    res.writeHead(code, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }

  if (req.method === 'GET' && req.url === '/health') return send(200, { ok: true })
  if (req.method === 'GET' && req.url === '/todos') return send(200, { todos })
  if (req.method === 'POST' && req.url === '/todos') {
    let raw = ''
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => {
      let title
      try { title = JSON.parse(raw).title } catch { /* fall through */ }
      if (typeof title !== 'string' || title.trim() === '') {
        return send(400, { error: 'title is required' })
      }
      const todo = { id: todos.length + 1, title: title.trim(), done: false }
      // BUG: the new todo is acknowledged but never stored — GET /todos stays
      // empty. The heal agent's fix is the missing `todos.push(todo)`.
      return send(201, { todo })
    })
    return
  }
  send(404, { error: 'not found' })
})

const port = Number(process.env.PORT || 4173)
server.listen(port, () => {
  console.log(`first-flight-app listening on http://localhost:${port}`)
})
