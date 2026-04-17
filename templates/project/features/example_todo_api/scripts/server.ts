import http, { type IncomingMessage } from 'node:http'

interface Todo {
  id: string
  title: string
  done: boolean
}

const todos: Todo[] = []
let nextId = 1

const readBody = async (req: IncomingMessage): Promise<Record<string, unknown>> => {
  let body = ''
  for await (const chunk of req) body += chunk
  return body ? JSON.parse(body) : {}
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
  const method = req.method ?? 'GET'

  console.log(`[example_todo_api] ${method} ${url.pathname}`)
  res.setHeader('Content-Type', 'application/json')

  try {
    if (method === 'GET' && url.pathname === '/') {
      res.end(JSON.stringify({ status: 'ok' }))
      return
    }

    if (method === 'GET' && url.pathname === '/todos') {
      res.end(JSON.stringify(todos))
      return
    }

    if (method === 'POST' && url.pathname === '/todos') {
      const { title } = (await readBody(req)) as { title?: string }
      const todo: Todo = { id: String(nextId++), title: title ?? '', done: false }
      todos.push(todo)
      res.writeHead(201)
      res.end(JSON.stringify(todo))
      return
    }

    if (method === 'DELETE' && url.pathname.startsWith('/todos/')) {
      const [, , id] = url.pathname.split('/')
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
  } catch (err) {
    res.writeHead(500)
    res.end(JSON.stringify({ error: (err as Error).message }))
  }
})

const port = Number.parseInt(process.env.PORT ?? '4000', 10)
server.listen(port, () => {
  console.log(`Example TODO API listening on http://localhost:${port}`)
})
