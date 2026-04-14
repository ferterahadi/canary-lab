import { GATEWAY_URL } from '../../src/config'

interface Todo {
  id: string
  title: string
  done: boolean
}

export class TodoApi {
  private baseUrl = GATEWAY_URL

  async create(title: string): Promise<Todo> {
    const res = await fetch(`${this.baseUrl}/todos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    })
    if (!res.ok) throw new Error(`POST /todos failed: ${res.status}`)
    return res.json()
  }

  async list(): Promise<Todo[]> {
    const res = await fetch(`${this.baseUrl}/todos`)
    if (!res.ok) throw new Error(`GET /todos failed: ${res.status}`)
    return res.json()
  }

  async remove(id: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/todos/${id}`, { method: 'DELETE' })
    if (!res.ok && res.status !== 204)
      throw new Error(`DELETE /todos/${id} failed: ${res.status}`)
  }
}
