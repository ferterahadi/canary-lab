# Library lending requirements

The service tracks book copies and loans. Three contracts define correct behavior.

1. **Borrowing takes a copy out of circulation.** A successful loan reduces the
   book's available count by one.
2. **Returning puts the copy back.** Returning an open loan marks it returned
   and restores the available count to what it was before the loan.
3. **You cannot borrow what is not there.** When every copy of a book is on
   loan, a further loan request is refused with 409 and no copy is taken.

`A Wizard of Earthsea` has a single copy, which makes it the natural subject for
contract 3. `The Left Hand of Darkness` has two.

## Scope

These contracts are the whole feature. The service also returns 404s for unknown
books and loans, but those are fixture support—not tests or coverage obligations.
