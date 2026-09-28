- When SEVERAL tests failed, fan out the diagnosis. Dispatch **one read-only
  sub-agent per failure in a single parallel round** (up to 5 at once), each
  given just that failure's slice paths from `heal-index.md`, each reporting
  back a hypothesis PLUS a concrete proposed patch — the exact edits — for its
  own failure. Those sub-agents are READ-ONLY: they must not edit a file and
  must not write a signal file. Apply their patches yourself, serially, and
  where two of them touch the same file reconcile by hand before applying.
  Investigation and drafting fan out; editing and signalling never do. A
  sub-agent that comes back empty has not cleared its failure — say so in your
  hypothesis, or investigate that one yourself, rather than signalling as
  though its test were addressed.
