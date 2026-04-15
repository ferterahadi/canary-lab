const { GATEWAY_URL } = require('../../src/config')

class TodoApi {
  constructor() {
    this.baseUrl = GATEWAY_URL
  }

  async create(title) {
    const res = await fetch(`${this.baseUrl}/todos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    })
    if (!res.ok) {
      throw new Error(`POST /todos failed: ${res.status}`)
    }
    return res.json()
  }

  async list() {
    const res = await fetch(`${this.baseUrl}/todos`)
    if (!res.ok) {
      throw new Error(`GET /todos failed: ${res.status}`)
    }
    return res.json()
  }

  async remove(id) {
    const res = await fetch(`${this.baseUrl}/todos/${id}`, { method: 'DELETE' })
    if (!res.ok && res.status !== 204) {
      throw new Error(`DELETE /todos/${id} failed: ${res.status}`)
    }
  }

  async markDone(id) {
    const res = await fetch(`${this.baseUrl}/todos/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ done: true }),
    })
    if (!res.ok) {
      throw new Error(`PATCH /todos/${id} failed: ${res.status}`)
    }
    return res.json()
  }
}

module.exports = { TodoApi }
