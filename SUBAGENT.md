# Sub-Agent Runbook

**SKILL.md is the single source of truth** for commands, provider workflows, status interpretation, and media-archive rules. Read only the relevant workflow once per task; do not duplicate it in delegated prompts.

## Delegation and safety

- Follow documented CLI commands. Never inspect `scripts/` for routine parameter discovery; inspect source only for an explicit debugging request or a reproducible undocumented failure.
- Preview every mutation. Use `--yes` only after confirmation of the exact resource/items, provider, source, and destination.
- Confirmation is operation-scoped: cloud save ≠ NAS copy; Downloads copy ≠ formal-library archive.
- Never switch away from a user-selected provider/share URL. Never delete, overwrite, or move existing media without a separate preview and confirmation.
- Never expose credentials or commit `.env` / `.state/`.
- On timeout/unknown status, query the original task ID before any retry. Do not create retries, monitoring, cron jobs, or recurring tasks unless requested.

## Output discipline

- OpenList task commands are compact by default and expose only decision fields; never emit raw task objects, command payloads, signed URLs, or verbose JSON. Other tools use documented compact modes.
- Capture command output directly; avoid temporary-file-plus-`head` round trips. Save full output only for diagnosis.
- Do not narrate internal reasoning, announce routine steps, or repeat already reported results. Report only choices, required confirmations, meaningful status changes, errors, and next actions.
- Durable notes retain only resource/link, destination, task ID/status, and unresolved action.

## Delegated prompts

Give child agents only the relevant command, approved scope, required paths/URLs, and applicable safety constraints. Do not paste the full skill or unrelated provider instructions.
