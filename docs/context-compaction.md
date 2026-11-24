# Conversation context compaction

The main agent targets the freshest approximately 30% of the request window plus a
factual recap of the older prefix. System instructions and completion reserves are
retained. Boundaries are complete model/tool exchanges, never a tool call separated
from its results. This is a target, not an exact per-message token promise.

## Measurements

`MessageUsage.context_window` stores the main model's provider measurements before
and after an exchange, with an epoch identifying the model, instructions, tool set
and summary prefix. Comparable checkpoints guide the boundary. Provider deltas are
approximate prefix growth, not independently measured sizes of individual messages.
Sparse legacy histories retain recent complete exchanges until a new measurement is
available. Local token counting is used only when no provider measurement exists;
subagent, router, vision and summary-agent windows do not measure the main context.

Compaction is checked before main model calls and after the final response. A
provider context-overflow error permits one compression/retry of the model request.
Completed tools are not executed again. Quota accounting remains separate and
includes auxiliary calls. Interrupted tools have an explicitly unknown outcome.

## Persistence and failures

The existing `chat_context_summaries` table also holds an internal `snapshot_json`:
the verbatim recent tail, its provenance and checkpoints. Original messages and
full tool traces remain available for display. Loading context uses the snapshot
and subsequently observed rows; it never reinserts the original expanded trace.
The snapshot identifies covered timeline positions so unseen concurrent room
messages survive. Room summaries remain private to each initiating human and do
not archive shared rows. Agent switches do not reuse another agent's snapshot.

The recap, tail and personal archive boundary commit in one transaction, with
checks for concurrent summary changes and edits/deletions of source messages.
No source is archived before successful summarization. Summary failures, including
empty model output, preserve the old recap and original history; completed work is
saved and generation pauses visibly. Scalar token counters never unarchive rows.

`context_measurement_stale` indicates that the last actual provider measurement
predates compaction or new input. The following measured request refreshes it.
Custom themes receive a labeled `state.context.summary`, independent of showTokens;
see the generated `docs/session.md` for the display contract. The recap also enters
the model context with explicit summary delimiters, not as a new user request.
