import { GATEWAY_URL } from '../../src/config'

export interface Todo {
  id: string
  title: string
  done: boolean
}

const jsonRequest = async <T>(url: string, init: RequestInit = {}): Promise<T | null> => {
  const res = await fetch(url, {
    ...init,
    headers: {
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  })
  if (!res.ok && res.status !== 204) {
    throw new Error(`${init.method ?? 'GET'} ${url} failed: ${res.status}`)
  }
  return res.status === 204 ? null : ((await res.json()) as T)
}

export class TodoApi {
  baseUrl = GATEWAY_URL

  create = (title: string) =>
    jsonRequest<Todo>(`${this.baseUrl}/todos`, {
      method: 'POST',
      body: JSON.stringify({ title }),
    })

  list = () => jsonRequest<Todo[]>(`${this.baseUrl}/todos`)

  remove = (id: string) =>
    jsonRequest<null>(`${this.baseUrl}/todos/${id}`, { method: 'DELETE' })
}
