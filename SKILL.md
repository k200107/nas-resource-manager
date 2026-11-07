---
name: resource-2-nas
description: Search media resources, save Aliyun/Quark/Baidu shares, copy them through OpenList to NAS, inspect tasks, and plan media organization.
---

# Resource 2 NAS

Use this skill for media search, cloud-drive share saving, OpenList task inspection/copy, and media organization.

## Defaults

- Search provider order: Aliyun → Quark → Baidu. Only choose a provider listed as usable by the relevant readiness check.
- Search returns 10 candidates by default. Use --max-candidates 30 only when the user asks for more.
- Cloud-drive save folder: provider-specific save path, default /影视库.
- Media copy staging folder: /本地存储/Downloads.
- Final libraries: /本地存储/Movies and /本地存储/TVShows.
- Generic copy fallback: /本地存储.
- Cloud-drive /影视库 and OpenList /本地存储/... are different storage systems.

## Commands

| Task | Command |
|---|---|
| Search for agent | npm run search -- "片名" --format json --compact |
| Search for user display | npm run search -- "片名" --max-candidates 10 |
| Readiness (first setup or after auth/path error) | npm run check-ready |
| Focused env check | npm run check-env -- --json |
| Aliyun preview | npm run aliyun-save -- "$URL" "$DEST" --dry-run --format json |
| Quark preview | npm run quark-save -- "$URL" "$DEST" --dry-run --format json |
| Baidu preview | npm run baidu-save -- "$URL" "$DEST" --dry-run --format json |
| OpenList copy preview | npm run openlist-copy -- "$SRC" "$DST" "$NAME" --format json |
| OpenList copy after confirmation | Same command with --yes --format json |
| Inspect copy tasks | npm run openlist-tasks -- list copy undone --format json or list copy done |

## Minimal workflow

1. Search: use compact JSON for Agent decisions. Deduplicate by provider + share URL. Show a short list (normally 5–10) with title, provider, link, extraction code, and relevant quality hints.
2. Select: ask the user to select a resource when multiple plausible candidates exist. Confirmation applies only to the selected resource and stated operation.
3. Preview save: run the provider dry-run. Show selected items and actual destination before a write.
4. Save: after explicit confirmation, rerun with --yes. Interpret provider results:
   - Documented synchronous terminal success = SUCCEEDED.
   - Accepted response or task ID = ACTIVE until the provider task reports terminal success.
   - Explicit API error = FAILED.
   - Missing/ambiguous task evidence = UNKNOWN.
   Do not re-list every saved file after clear terminal success. Do not treat generic HTTP 200/202 or accepted as terminal success when the provider uses asynchronous tasks.
5. Copy to NAS: preview source, exact item name, destination, and conflicts. After confirmation, run fs/copy through openlist-copy.
6. Copy status: use the exact returned task ID. One task snapshot is enough: task in undone = ACTIVE; task in done with no error = SUCCEEDED; explicit error = FAILED; task missing from both = UNKNOWN. Do not repeatedly poll, refresh the destination, enumerate every copied file, compare sizes, or calculate hashes by default.
7. Organize: only when requested. Plan destination and conflicts first. Moving/renaming into Movies or TVShows requires separate explicit confirmation.

## Token-efficient rules

- For Agent search, use --format json --compact. This returns one flat row per result without duplicate nested candidate/download-link structures.
- Default to 10 candidates. Expand only on request.
- Do not call --check-links unless the user asks for link verification or the result set is unusually uncertain.
- Run full check-ready only on first setup or after an authentication/path failure. During normal use, let the selected provider/OpenList call report a concrete error; then run only the relevant focused check.
- Do not re-read SKILL, SUBAGENT, and all provider instructions repeatedly within one task. Read the applicable workflow once; load provider details only when needed.
- Do not repeat a verification merely to produce a more detailed report. Report API/task status and its evidence.

## Safety

- Never print, commit, or request raw credentials, cookies, or authorization headers. .env and .state/ must remain uncommitted.
- Never use --yes before the user or supervising Agent confirms the exact preview payload, source, destination, and selected items.
- Confirmation is scoped: confirming cloud save does not authorize NAS copy; confirming Downloads copy does not authorize archive into Movies/TVShows.
- Never overwrite or delete existing files, or modify the formal media library without a separate preview and confirmation.
- Do not create background retries, monitoring, cron jobs, or recurring tasks unless requested.
- Do not retry a mutation blindly after timeout or unknown status. Query the original task first.
- OPENLIST_DEFAULT_COPY_DST_PATH is the generic copy fallback; OPENLIST_STAGING_PATH is the media staging folder. Do not interchange them.
- Use OPENLIST_BASE_URL and OPENLIST_TOKEN for OpenList requests.

## Result vocabulary

Use only these states in user reports:

- SUBMITTED: write request accepted, no terminal task result yet.
- ACTIVE: task is still running.
- SUCCEEDED: provider/OpenList task has a clear terminal success result.
- FAILED: explicit terminal failure.
- UNKNOWN: no reliable terminal status is available.

Never call a task complete based only on a request being accepted or a destination directory being visible.
