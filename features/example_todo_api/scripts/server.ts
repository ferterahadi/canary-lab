import http from 'http'

interface Todo {
  id: string
  title: string
  done: boolean
}

const todos: Todo[] = []
let nextId = 1

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
  const method = req.method ?? 'GET'

  res.setHeader('Content-Type', 'application/json')

  // Health check
  if (method === 'GET' && url.pathname === '/') {
    res.end(JSON.stringify({ status: 'ok' }))
    return
  }

  // GET /todos
  if (method === 'GET' && url.pathname === '/todos') {
    res.end(JSON.stringify(todos))
    return
  }

  // POST /todos
  if (method === 'POST' && url.pathname === '/todos') {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      const { title } = JSON.parse(body)
      const todo: Todo = { id: String(nextId++), title, done: false }
      todos.push(todo)
      res.writeHead(201)
      res.end(JSON.stringify(todo))
    })
    return
  }

  // DELETE /todos/:id
  if (method === 'DELETE' && url.pathname.startsWith('/todos/')) {
    const id = url.pathname.split('/')[2]
    const idx = todos.findIndex((t) => t.id === id)
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

const port = parseInt(process.env.PORT ?? '4000', 10)
server.listen(port, () => console.log(`Todo API listening on http://localhost:${port}`))
