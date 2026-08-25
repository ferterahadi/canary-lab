# Workflow workbench

This small service supports Canary Lab's focused workflow demonstrations. Its
suite starts with an unlinked health test and no personalized-greeting test. The
server intentionally binds a fixed port, so Coverage, Author, and Portify each
have real work to show.

The application behavior is correct. Authoring adds missing evidence; it should
not change this service merely to make a new test pass.
