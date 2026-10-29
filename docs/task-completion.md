# Scheduled AI completion

Scheduled AI instructions use the existing model/tool pipeline with read-only conversation history (`skipHistory`), existing model access, tool restrictions, quota checks and accounting.

Each run must end with a single `finish_task` call, alone:

```json
{"notify_user": false, "message": ""}
```

For a reportable result, use `notify_user: true` and a non-empty `message`. The server validates these fields. Ordinary text, intermediate narration and tool results never decide delivery. Invalid completion arguments are returned as tool errors; missing completion is a failed run, with bounded reminders for ordinary final answers. The model must support tools. `finish_task` is a run-control operation and remains available even with an empty task tool whitelist.

Delivery still respects the task's `notify_mode`: `never` suppresses reports, and `on_error` only reports failed runs. A destination chat is created or redirected only when there is a report to deliver (or an error report explicitly enabled by `on_error`). Silent runs do not write task messages into an existing conversation either. A new-chat run uses account defaults without creating a placeholder chat; a valid personal target can supply conversation context.

Each execution is recorded in `task_runs`, including manual test runs: status, explicit notification decision, result, tool trace, usage, destination, delivery and error. Existing token usage accounting remains the source of billing. Silent recurring tasks advance their schedule normally. Test runs keep the schedule unchanged. Ordinary reminders and smart-home tasks retain their prior history behavior.

Checks: `backend-api/tests/task-delivery.test.mts` exercises the scheduler with a real temporary database; `backend-api/tests/task-ai-completion.test.mts` exercises the AI loop with a local fake provider. Neither calls a paid model.
