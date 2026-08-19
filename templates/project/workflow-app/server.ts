import http from 'node:http'

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  res.setHeader('Content-Type', 'application/json')

  if (req.method === 'GET' && url.pathname === '/health') {
    res.writeHead(200)
    res.end(JSON.stringify({ status: 'ok' }))
    return
  }

  if (req.method === 'GET' && url.pathname === '/greeting') {
    const name = url.searchParams.get('name')?.trim()
    if (!name) {
      res.writeHead(400)
      res.end(JSON.stringify({ error: 'name is required' }))
      return
    }
    res.writeHead(200)
    res.end(JSON.stringify({ message: `Hello, ${name}!` }))
    return
  }

  res.writeHead(404)
  res.end(JSON.stringify({ error: 'not found' }))
})

// Fixed on purpose: the Portify demo changes this service to read an injected
// port, then Canary Lab proves two isolated copies can boot at once.
server.listen(4600, () => {
  console.log('Workflow demo listening on http://localhost:4600')
})
