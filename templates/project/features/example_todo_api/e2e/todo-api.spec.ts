import { test, expect } from 'canary-lab/feature-support/log-marker-fixture'
import { TodoApi } from './helpers/api'

const api = new TodoApi()

test.describe('example_todo_api', () => {
  // @requirement R1
  // @path happy
  test('POST /todos creates a todo', async () => {
    const todo = await api.create('Buy milk')
    expect(todo?.id).toBeTruthy()
    expect(todo?.title).toBe('Buy milk')
    expect(todo?.done).toBe(false)
  })

  // @requirement R2
  // @path happy
  test('GET /todos lists todos', async () => {
    const todos = await api.list()
    expect(todos?.length ?? 0).toBeGreaterThan(0)
  })

  // @requirement R3
  // @path happy
  test('DELETE /todos/:id removes a todo', async () => {
    const todo = await api.create('Temporary item')
    await api.remove(todo!.id)
    const todos = await api.list()
    expect(todos?.find((entry) => entry.id === todo!.id)).toBeUndefined()
  })
})
