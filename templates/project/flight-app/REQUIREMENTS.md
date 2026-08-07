# Library lending requirements

The lending service tracks copies of books and who has them out. Three
contracts define correct behaviour.

1. **Borrowing takes a copy out of circulation.** Creating a loan for a book
   with copies free succeeds, and the book's available count drops by exactly
   one.
2. **Returning puts the copy back.** Returning an open loan marks it returned
   and restores the available count to what it was before the loan.
3. **You cannot borrow what is not there.** When every copy of a book is on
   loan, a further loan request is refused with 409 and no copy is taken.

`A Wizard of Earthsea` has a single copy, which makes it the natural subject for
contract 3. `The Left Hand of Darkness` has two.

## Scope

These three contracts are the whole feature. The service also returns 404s for
unknown books and unknown loans so it behaves like a real small API, but those
are not acceptance requirements — do not turn them into separate tests or
coverage obligations.
