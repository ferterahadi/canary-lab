const http = require('http')

const todos = []
let nextId = 1

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
  const method = req.method ?? 'GET'

  console.log(`[example_todo_api] ${method} ${url.pathname}`)
  res.setHeader('Content-Type', 'application/json')

  if (method === 'GET' && url.pathname === '/') {
    res.end(JSON.stringify({ status: 'ok' }))
    return
  }

  if (method === 'GET' && url.pathname === '/todos') {
    res.end(JSON.stringify(todos))
    return
  }

  if (method === 'POST' && url.pathname === '/todos') {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}')
      const todo = { id: String(nextId++), title: parsed.title, done: false }
      todos.push(todo)
      res.writeHead(201)
      res.end(JSON.stringify(todo))
    })
    return
  }

  if (method === 'DELETE' && url.pathname.startsWith('/todos/')) {
    const id = url.pathname.split('/')[2]
    const idx = todos.findIndex((todo) => todo.id === id)
    if (idx === -1) {
      res.writeHead(404)
      res.end(JSON.stringify({ error: 'not found' }))
      return
    }

    todos.splice(idx, 1)
    res.writeHead(204)
    res.end()
    return
  }

  res.writeHead(404)
  res.end(JSON.stringify({ error: 'not found' }))
})

const port = Number.parseInt(process.env.PORT ?? '4000', 10)
server.listen(port, () => {
  console.log(`Example TODO API listening on http://localhost:${port}`)
})
