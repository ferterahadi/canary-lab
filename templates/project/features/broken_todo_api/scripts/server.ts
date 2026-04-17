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

  console.log(`[broken_todo_api] ${method} ${url.pathname}`)
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

    if (method === 'PATCH' && url.pathname.startsWith('/todos/')) {
      const [, , id] = url.pathname.split('/')
      const todo = todos.find((entry) => entry.id === id)
      if (!todo) {
        res.writeHead(404)
        res.end(JSON.stringify({ error: 'not found' }))
        return
      }
      const { done } = (await readBody(req)) as { done?: boolean }
      console.log(`[broken_todo_api] simulated bug: ignoring done=${done} for ${id}`)
      res.end(JSON.stringify(todo))
      return
    }

    if (method === 'DELETE' && url.pathname.startsWith('/todos/')) {
      const [, , id] = url.pathname.split('/')
      console.log(`[broken_todo_api] simulated bug: refusing to delete ${id}`)
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

const port = Number.parseInt(process.env.PORT ?? '4100', 10)
server.listen(port, () => {
  console.log(`Broken TODO API listening on http://localhost:${port}`)
})
