# example_todo_api — Product Requirements

The source PRD for the Verified Coverage Ledger. Edit this file and regenerate the
summary (Docs tab → "Regenerate PRD summary", or the `regenerate_prd_summary` MCP
tool) — requirement ids are preserved across regeneration.

## Create a todo
A `POST /todos` with a `title` creates a todo, returns its generated id, and marks
it `done: false`. A request with no title is rejected (negative path).

## List todos
`GET /todos` returns every todo that has been created, in creation order.

## Delete a todo
`DELETE /todos/:id` removes the todo so it no longer appears in the list. Removal
should ultimately be confirmable from the user-facing surface (a browser viewing the
list), not only from the API response.

## Update a todo
`PATCH /todos/:id` changes a todo's title or its done state and returns the updated
todo. (Not yet implemented or tested — included to show an untested requirement.)
