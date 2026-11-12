---
name: resource-2-nas
description: Search media resources, save cloud-drive shares, copy through OpenList to NAS, inspect tasks, and organize media.
---

# Resource 2 NAS

Use this skill only for media resource search, cloud-drive save, OpenList copy/task handling, and media organization.

## Load only the relevant workflow

Read this file once, then read exactly one workflow file for the current task. Do not load all workflow files.

| User request | Read |
|---|---|
| Search a title, choose a share, save to Aliyun/Quark/Baidu | `workflows/search-and-save.md` |
| Discover mounts, copy to NAS, inspect/cancel tasks | `workflows/openlist-copy.md` |
| Plan, rename, move, or archive media (including files downloaded elsewhere) | `workflows/media-organization.md` |
| A task spans stages | Read the next workflow only when reaching that stage; carry forward prior results instead of rereading |

## Shared safety

- Preview every mutation. Execute only after user confirmation of the exact resource, items, provider, operation, and destination.
- Confirmation is operation-scoped: cloud save ≠ NAS copy; Downloads copy ≠ formal-library archive.
- Never switch a user-selected provider/share URL. Never delete or overwrite existing media without a separate preview and confirmation.
- Never expose credentials, cookies, tokens, or authorization headers; never commit `.env` or `.state/`.
- On timeout or unknown mutation status, query the original task ID before considering retry. Never blindly resubmit.
- Do not create retries, monitoring, cron jobs, or recurring tasks unless requested.

## Token and output discipline

- Read the router and the one relevant workflow once. Do not reread instructions or source code to rediscover documented commands.
- Inspect scripts only for an explicit debugging request or a reproducible failure the workflow cannot explain.
- Prefer documented compact output. Do not print raw task objects, command payloads, signed URLs, or unrelated metadata.
- Capture command output directly; avoid temporary-file-plus-`head` round trips. Save full logs only for diagnosis and inspect relevant excerpts.
- Report only decisions, required confirmations, meaningful status changes, errors, and next actions. Do not narrate internal reasoning or repeat command output.
- Durable notes keep only resource/link, destination, task ID/status, and unresolved next action.

## Result vocabulary

- `SUBMITTED`: write accepted, no terminal task result.
- `ACTIVE`: task still running.
- `SUCCEEDED`: clear terminal success.
- `FAILED`: explicit terminal failure.
- `UNKNOWN`: no reliable terminal status.

Never call a task complete based only on request acceptance or destination visibility.
