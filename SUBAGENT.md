# Sub-Agent Runbook

Use this runbook for delegated media search, cloud-drive saves, OpenList copy/task operations, and media organization. Read SKILL.md for defaults and the workflow; do not duplicate or repeatedly reload provider implementation details.

## Essential rules

- Prefer JSON output; for search use --format json --compact.
- Search defaults to 10 candidates. Expand only when the user asks.
- Run check-ready only on first setup or after an auth/path failure. Otherwise use the selected provider operation and run a focused check only if it fails.
- Preview every mutating operation. Do not use --yes until the user confirms the exact resource, selected items, provider, and destination.
- User confirmation is operation-scoped: cloud save does not authorize NAS copy; NAS copy to Downloads does not authorize archive to Movies/TVShows.
- Never switch providers for an explicitly supplied share URL or user-selected provider.
- Never expose or commit credentials. Keep .env and .state/ out of Git.
- Do not delete, overwrite, or alter existing media-library files. Never write tests into the real media library.
- Do not create background retries, cron jobs, or monitoring unless explicitly requested.

## Search

    npm run search -- "$KW" --format json --compact

Show a concise, deduplicated shortlist. Preserve original share URLs and extraction codes. Do not call link checks unless requested or materially needed.

## Cloud-drive save

Use the matching adapter only:

- Aliyun: npm run aliyun-save -- "$URL" "$DEST" --dry-run --format json
- Quark: npm run quark-save -- "$URL" "$DEST" --dry-run --format json
- Baidu: npm run baidu-save -- "$URL" "$DEST" --dry-run --format json

Inspect the preview, classify movie/series/collection, and state the actual provider-side destination. After confirmation, rerun with --yes --format json.

Status interpretation:
- Synchronous API terminal success: SUCCEEDED.
- Accepted/task ID: ACTIVE until task status is terminal.
- Explicit API/task error: FAILED.
- Ambiguous or missing status: UNKNOWN.

Do not perform a second full file listing after clear terminal success. For asynchronous providers, query the task; do not infer completion from HTTP 200/202 alone.

## OpenList copy

Preview:

    npm run openlist-copy -- "$SRC_DIR" "$DST_DIR" "$NAME" --format json

After confirmation:

    npm run openlist-copy -- "$SRC_DIR" "$DST_DIR" "$NAME" --yes --format json

For a later status check, use one command: npm run openlist-tasks -- get copy --id "$TASK_ID" --format json. The helper checks the exact task ID in both task lists:
- undone: ACTIVE
- done with no error: SUCCEEDED
- explicit task error: FAILED
- missing from both lists: UNKNOWN

Do not repeatedly poll, refresh the destination, enumerate every copied file, compare sizes, or hash media files by default. If active/unknown, preserve the task ID and query that same task when the user asks for progress. Never resubmit blindly.

## Media organization

Run media-plan only when the user asks to organize staged media. Present the plan and conflicts. Archive/move/rename requires separate confirmation. Preserve multi-season folder structures. Never overwrite a same-name target.

## Credentials and paths

- Credentials: ALIYUN_REFRESH_TOKEN, QUARK_COOKIE, BAIDU_COOKIE, OPENLIST_TOKEN. Never print them or raw auth headers.
- Cloud-drive save folder defaults to /影视库.
- OpenList staging defaults to /本地存储/Downloads.
- Formal libraries: /本地存储/Movies and /本地存储/TVShows.
- Generic copy fallback: /本地存储; do not confuse it with the staging folder.

## User-facing status

Use SUBMITTED, ACTIVE, SUCCEEDED, FAILED, or UNKNOWN. Distinguish request acceptance from task completion. Keep reports concise: resource, provider, source/target path, task ID, status, and next action.
