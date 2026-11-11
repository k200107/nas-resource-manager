# Sub-Agent Runbook

Use this runbook for delegated media search, cloud-drive saves, OpenList copy/task operations, and media organization. Read SKILL.md once per task for the applicable workflow. Never open script source files to discover routine CLI usage; use the documented commands and compact JSON output.

## Essential rules

- Prefer JSON output; for search and OpenList copy use --format json --compact. Compact search returns candidate title/provider/link/code plus provider availability; compact copy returns source item, destination, conflicts, and task status/ID.
- Search defaults to 10 candidates. Expand only when the user asks.
- Run check-ready only on first setup or after an auth/path failure. Otherwise use the selected provider operation and run a focused check only if it fails.
- Do not read files under scripts/ for routine parameter discovery or to explain normal command behavior. If a documented command fails, report its error first; inspect implementation only for an explicit code-debugging request or a reproducible undocumented failure.
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

- Aliyun: npm run aliyun-save -- "$URL" "$DEST" --context-name "$CANONICAL_TITLE" --resource-type movie --dry-run --format json
- Quark: npm run quark-save -- "$URL" "$DEST" --dry-run --format json
- Baidu: npm run baidu-save -- "$URL" "$DEST" --dry-run --format json

Inspect the preview, classify movie/series/collection, and state the actual provider-side destination. When the URL came from search, pass the clean search-result title via --context-name (and the known --resource-type); never assume the share's folder name is canonical. If a selected folder needs cleanup but renamePlan is empty, do not save: correct the context name or provide a validated rename plan, then preview again. Renaming a folder only changes the folder name, not its children. After confirmation, rerun with --yes --format json, retaining the same naming arguments.

Status interpretation:
- Synchronous API terminal success: SUCCEEDED.
- Accepted/task ID: ACTIVE until task status is terminal.
- Explicit API/task error: FAILED.
- Ambiguous or missing status: UNKNOWN.

Do not perform a second full file listing after clear terminal success. For asynchronous providers, query the task; do not infer completion from HTTP 200/202 alone.

## OpenList copy

Preview (pass the full item path once; the script derives its parent directory and item name):

    npm run openlist-copy -- --source-item-path "$SOURCE_ITEM_PATH" --dst-dir "$DST_DIR" --format json --compact

After confirmation, rerun the same command with `--yes`:

    npm run openlist-copy -- --source-item-path "$SOURCE_ITEM_PATH" --dst-dir "$DST_DIR" --yes --format json --compact

For a later status check, use one command: npm run openlist-tasks -- get copy --id "$TASK_ID" --format json. The helper checks the exact task ID in both task lists:
- undone: ACTIVE
- done with no error: SUCCEEDED
- explicit task error: FAILED
- missing from both lists: UNKNOWN

Do not repeatedly poll, refresh the destination, enumerate every copied file, compare sizes, or hash media files by default. If active/unknown, preserve the task ID and query that same task when the user asks for progress. Never resubmit blindly.

## Media organization

Only when requested:
1. Named file: `npm run --silent media-plan -- --file "$FILE" --format json --compact`. Use `--source-dir` only for a requested directory/batch.
2. Preserve that plan. Preflight with `npm run --silent media-archive -- --plan-file "$PLAN_FILE" --compact`.
3. Show the exact source/target and conflicts. After confirmation, annotate only confirmed review items and execute the same plan with `--yes --compact`.
4. Do not rescan, regenerate the plan, reread scripts, or repeat post-success verification. The executor performs a fresh pre-mutation check.

Preserve multi-season folder structures. Never overwrite a same-name target.

## Credentials and paths

- Credentials: ALIYUN_REFRESH_TOKEN, QUARK_COOKIE, BAIDU_COOKIE, OPENLIST_TOKEN. Never print them or raw auth headers.
- Cloud-drive save folder defaults to /影视库.
- OpenList staging defaults to /本地存储/Downloads.
- Formal libraries: /本地存储/Movies and /本地存储/TVShows.
- Generic copy fallback: /本地存储; do not confuse it with the staging folder.

## User-facing status

Use SUBMITTED, ACTIVE, SUCCEEDED, FAILED, or UNKNOWN. Distinguish request acceptance from task completion. Keep reports concise: resource, provider, source/target path, task ID, status, and next action.
