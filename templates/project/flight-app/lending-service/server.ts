import http, { type IncomingMessage } from 'node:http'

// A small library-lending API. Unlike demo-app/, nothing here is pre-onboarded:
// there is no suite for it, so a Flight has to read the repository, derive the
// contracts, author the tests, make the port injectable, run, heal and export.

interface Book {
  id: string
  title: string
  copies: number
  onLoan: number
}

interface Loan {
  id: string
  bookId: string
  status: 'open' | 'returned'
}

const books: Book[] = [
  { id: 'b1', title: 'The Left Hand of Darkness', copies: 2, onLoan: 0 },
  { id: 'b2', title: 'A Wizard of Earthsea', copies: 1, onLoan: 0 },
]
const loans = new Map<string, Loan>()
let nextLoanId = 1

const availableCopies = (book: Book): number => book.copies - book.onLoan

const readBody = async (req: IncomingMessage): Promise<Record<string, unknown>> => {
  let body = ''
  for await (const chunk of req) body += chunk
  return body ? JSON.parse(body) : {}
}

const json = (res: http.ServerResponse, status: number, payload: unknown): void => {
  res.writeHead(status)
  res.end(JSON.stringify(payload))
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const segments = url.pathname.split('/').filter(Boolean)
  const method = req.method ?? 'GET'
  res.setHeader('Content-Type', 'application/json')
  console.log(`[lending-service] ${method} ${url.pathname}`)

  try {
    if (method === 'GET' && segments.length === 0) {
      json(res, 200, { status: 'ok', service: 'lending' })
      return
    }

    // GET /books — every title with its available count.
    if (method === 'GET' && segments[0] === 'books' && segments.length === 1) {
      json(res, 200, books.map((book) => ({ ...book, available: availableCopies(book) })))
      return
    }

    // GET /books/:id
    if (method === 'GET' && segments[0] === 'books' && segments.length === 2) {
      const book = books.find((entry) => entry.id === segments[1])
      if (!book) {
        json(res, 404, { error: 'unknown book' })
        return
      }
      json(res, 200, { ...book, available: availableCopies(book) })
      return
    }

    // POST /loans — borrow one copy, refusing when none are free.
    if (method === 'POST' && segments[0] === 'loans' && segments.length === 1) {
      const { bookId } = (await readBody(req)) as { bookId?: string }
      const book = books.find((entry) => entry.id === bookId)
      if (!book) {
        json(res, 404, { error: 'unknown book' })
        return
      }
      if (availableCopies(book) <= 0) {
        json(res, 409, { error: 'no copies available', available: 0 })
        return
      }
      book.onLoan += 1
      const loan: Loan = { id: String(nextLoanId++), bookId: book.id, status: 'open' }
      loans.set(loan.id, loan)
      json(res, 201, { ...loan, available: availableCopies(book) })
      return
    }

    // POST /loans/:id/return — hand the copy back.
    if (method === 'POST' && segments[0] === 'loans' && segments[2] === 'return') {
      const loan = loans.get(segments[1] ?? '')
      if (!loan) {
        json(res, 404, { error: 'unknown loan' })
        return
      }
      const book = books.find((entry) => entry.id === loan.bookId)!
      loan.status = 'returned'
      json(res, 200, { ...loan, available: availableCopies(book) })
      return
    }

    json(res, 404, { error: 'not found' })
  } catch (err) {
    json(res, 500, { error: (err as Error).message })
  }
})

// Hardcoded on purpose: two runs of this service at once would collide on the
// same port, which is exactly what the Flight's parallel-readiness stage exists
// to find and correct.
const PORT = 4500
server.listen(PORT, () => {
  console.log(`Lending service listening on http://localhost:${PORT}`)
})
