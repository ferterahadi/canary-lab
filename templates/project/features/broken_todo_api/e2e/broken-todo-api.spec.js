const { test, expect } = require('canary-lab/feature-support/log-marker-fixture')
const { TodoApi } = require('./helpers/api')

const api = new TodoApi()

test.describe('broken_todo_api', () => {
  test('POST /todos creates a todo', async () => {
    const todo = await api.create('Write logs')
    expect(todo.id).toBeTruthy()
    expect(todo.title).toBe('Write logs')
    expect(todo.done).toBe(false)
  })

  test('GET /todos lists created todos', async () => {
    const todo = await api.create('Visible in list')
    const todos = await api.list()
    expect(todos.find((entry) => entry.id === todo.id)?.title).toBe(
      'Visible in list',
    )
  })

  test('PATCH /todos/:id marks a todo as done', async () => {
    const todo = await api.create('Should become done')
    const updated = await api.markDone(todo.id)
    expect(updated.done).toBe(true)
  })

  test('DELETE /todos/:id removes a todo', async () => {
    const todo = await api.create('This should be removed')
    await api.remove(todo.id)
    const todos = await api.list()
    expect(todos.find((entry) => entry.id === todo.id)).toBeUndefined()
  })
})
