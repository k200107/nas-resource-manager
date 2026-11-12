# Sub-Agent Runbook

`SKILL.md` is the entry router. Read it once, then read only the one workflow file matching the delegated task. Do not load unrelated workflows or duplicate their procedures in prompts.

## Delegation constraints

- Give child agents only the task, approved scope, required paths/URLs, and applicable safety constraints.
- Follow the selected workflow's preview, confirmation, status, and recovery rules. Never switch a selected provider/share or overwrite/delete without separate confirmation.
- Carry forward exact provider/share/title, selected items, destination, and task IDs. Never repeat a completed stage to recover its state.
- Do not expose credentials or commit `.env` / `.state/`. Do not create retries, monitoring, or scheduled work unless requested.

## Output

- Use documented compact CLI output; do not reread source for routine usage.
- Report only choices, required confirmations, meaningful status changes, errors, and next actions. No internal reasoning or routine step narration.
- Durable notes contain only resource/link, destination, task ID/status, and unresolved action.
