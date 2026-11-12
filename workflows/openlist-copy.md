# OpenList Copy and Task Workflow

Read this file for OpenList mounts, copy submission, task progress, or task cancellation. Shared safety and output rules are in the parent `SKILL.md`.

## Relevant defaults

- OpenList staging: `/本地存储/Downloads`; formal libraries: `/本地存储/Movies`, `/本地存储/TVShows`.
- Generic copy fallback: `/本地存储`. Do not confuse it with the staging path.
- Cloud-drive `/影视库` and OpenList `/本地存储/...` are different storage systems.

## Commands

| Task | Command |
|---|---|
| Discover OpenList mounts | `npm run --silent openlist-copy -- --list-mounts --format json --compact` |
| OpenList copy preview | `npm run --silent openlist-copy -- "$SRC_PARENT" "$DST" "$ITEM_NAME" --format json --compact` |
| OpenList copy after confirmation | Same copy command with `--yes` |
| Inspect copy task | `npm run --silent openlist-tasks -- get copy --id "$TASK_ID" --compact` |
| Inspect multiple task IDs | `npm run --silent openlist-tasks -- get copy --ids "ID1,ID2,ID3" --compact` |
| List all copy tasks (active + done) | `npm run --silent openlist-tasks -- list copy all --compact --exclude-archived` |
| List all task groups and states | `npm run --silent openlist-tasks -- list all all --compact` |
| Task CLI help (offline) | `npm run --silent openlist-tasks -- --help` |

## Workflow

### OpenList copy
1. If the OpenList mount is unknown, run `--list-mounts` once; do not run `check-ready`, read `.env`, or write ad-hoc API scripts just to discover mounts. The command returns root mount names and configured staging/library paths in one read-only request.
2. Copy arguments are **source parent directory + item name + destination**. Example: to copy `/百度网盘/影视库/片名`, pass source `/百度网盘/影视库` and name `片名`, not the full item path as the source. If the full item path is mistakenly supplied with its basename, the script checks the parent and safely corrects it only when that exact item exists.
3. Use `OPENLIST_STAGING_PATH` for media ingestion (normally `/本地存储/Downloads`), not the formal Movies/TVShows library. Preview exact source, item name, destination, and conflicts. Execute only after confirmation.
4. Use `--compact` for copy commands. Agent output contains only source, destination, item names, conflicts, status, task ID, and actionable errors; it omits duplicate task/API objects and directory counts. The CLI checks the exact task ID through OpenList's `POST /api/task/copy/info?tid=...` endpoint. A string `state=succeeded` with progress 100 and no contradictory active status is `SUCCEEDED`. For legacy numeric OpenList responses, `state=2` is `SUCCEEDED` only when progress is at least 100, `endTime` is present, `totalBytes` is positive, and there is no error; a stale `status=uploading` is tolerated only with all of that terminal evidence. The directory-dispatch status `src object is dir, added all copy tasks of objs` is never file-copy success; track its child file tasks instead. Pending/running/canceling = `ACTIVE`; explicit error/canceled/errored = `FAILED`; incomplete or ambiguous state = `UNKNOWN`.
5. For task overviews, use one `list` call: `list copy undone` for active copy tasks, `list copy all` for both active and completed copy tasks, or `list all all` for all supported task groups and both states. Use `--compact` to return status counts plus decision fields. Add `--exclude-archived` for routine overviews; it filters task IDs already linked to a successful archive record in the local media task ledger and reports `archivedSkipped`. Do not infer archived status from a matching filename or existing destination. For multiple known IDs, use one `get copy --ids "ID1,ID2"`; an individual lookup failure must not prevent results for other IDs. Partial group/state API failures are returned in `queryErrors`; do not silently treat a partial overview as complete. Batch cancel is deliberately not supported with `all` selectors. Do not repeatedly poll, refresh destination, enumerate files, compare sizes, or hash by default. For ACTIVE/UNKNOWN, retain the task ID and query that same task only when the user asks for progress or recovery requires it. Never resubmit blindly.
6. When the copy command returns terminal `SUCCEEDED`, stop the copy stage. Do not issue a separate `openlist-tasks get`, refresh the destination, or enumerate files. For `ACTIVE`/`UNKNOWN`, retain the exact task ID; query it only when the user asks for progress or recovery requires it.

## Automatic archive handoff

- When a copy is part of a download-to-library workflow, archive may start automatically only after the actual file-copy task returns terminal `SUCCEEDED`.
- A directory-dispatch parent task is not file-copy success; wait for its child file task(s). Every required media file must have a terminal success result before handing off to archive. Pass the originating task ID to `media-archive` using `--openlist-task-id "$TASK_ID"` so the successful archive is linked to that copy task in the existing ledger.
- `ACTIVE`, `FAILED`, or `UNKNOWN` never authorizes automatic archive. Keep the task ID and report/resolve that state instead.
