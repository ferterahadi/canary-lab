import { test, expect } from '../../../shared/e2e-runner/log-marker-fixture'
import { TodoApi } from './helpers/api'

const api = new TodoApi()

test.describe('example_todo_api', () => {
  test('POST /todos — creates a todo', async () => {
    const todo = await api.create('Buy milk')
    expect(todo.id).toBeTruthy()
    expect(todo.title).toBe('Buy milk')
    expect(todo.done).toBe(false)
  })

  test('GET /todos — lists todos', async () => {
    const todos = await api.list()
    expect(todos.length).toBeGreaterThan(0)
  })

  test('DELETE /todos/:id — removes a todo', async () => {
    const todo = await api.create('Temporary item')
    await api.remove(todo.id)
    const todos = await api.list()
    expect(todos.find((t) => t.id === todo.id)).toBeUndefined()
  })
})
