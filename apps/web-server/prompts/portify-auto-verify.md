Canary is ALREADY RUNNING the concurrent double-boot: the suite declares port
injection or a matching saved patch was pre-applied. There may be nothing to edit.
Do NOT edit the worktree, and do NOT call submit_external_portify while verification runs.
Poll get_portify: `ready-to-save` means both boots passed, so call save_portify.
`editing` means verification failed; read `verification.failureDetail`, fix the
worktree using the instructions below, and submit as usual. Declarations alone
are not proof that injection works.
