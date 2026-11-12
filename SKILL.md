---
name: resource-2-nas
description: Search media resources, save Aliyun/Quark/Baidu shares, copy them through OpenList to NAS, inspect tasks, and plan media organization.
---

# Resource 2 NAS

This is the canonical workflow for media search, cloud-drive saves, OpenList copy/tasks, and media organization. Sub-agent documents contain delegation constraints only; do not duplicate this workflow.

## Defaults

- Provider order: Aliyun → Quark → Baidu. Use only providers reported usable.
- Search defaults to 10 candidates; expand only when requested. Results are deduplicated by share URL and interleaved; check `providerAvailable` before saying a provider has no results.
- Cloud save default: `/影视库`. OpenList staging: `/本地存储/Downloads`. Libraries: `/本地存储/Movies`, `/本地存储/TVShows`. Generic copy fallback: `/本地存储`.
- Cloud-drive `/影视库` and OpenList `/本地存储/...` are different storage systems.
- Missing cloud save folders appear in preview and are created only after confirmation plus `--yes`; existing folders are reused, never overwritten. `--no-create-dir` restores fail-fast behavior.

## Commands

| Task | Command |
|---|---|
| Agent search | `npm run --silent search -- "片名" --format json --compact` |
| User-facing search | `npm run --silent search -- "片名" --max-candidates 10` |
| Readiness (first setup/auth/path error) | `npm run --silent check-ready` |
| Focused env check | `npm run --silent check-env -- --json` |
| Aliyun preview | `npm run --silent aliyun-save -- "$URL" "$DEST" --context-name "$CANONICAL_TITLE" --resource-type movie --dry-run --format json --compact` |
| Quark preview | `npm run --silent quark-save -- "$URL" "$DEST" --dry-run --format json --compact` |
| Baidu preview | `npm run --silent baidu-save -- "$URL" "$DEST" --dry-run --format json --compact` |
| Resume Baidu rename (preview) | `npm run --silent baidu-save -- --resume-rename --source-path "$SOURCE_PATH" --rename-to "$NAME" [--expected-id "$EXPECTED_ID"] --dry-run --format json --compact` |
| Resume Baidu rename (confirmed) | Same recovery command with `--yes` after preview and confirmation |
| Discover OpenList mounts | `npm run --silent openlist-copy -- --list-mounts --format json --compact` |
| OpenList copy preview | `npm run --silent openlist-copy -- "$SRC_PARENT" "$DST" "$ITEM_NAME" --format json --compact` |
| Provider save after confirmation | Same provider command with `--yes`, retaining naming arguments and compact JSON |
| OpenList copy after confirmation | Same copy command with `--yes` |
| Inspect copy task | `npm run --silent openlist-tasks -- get copy --id "$TASK_ID" --compact` |
| Inspect multiple task IDs | `npm run --silent openlist-tasks -- get copy --ids "ID1,ID2,ID3" --compact` |
| List all copy tasks (active + done) | `npm run --silent openlist-tasks -- list copy all --compact` |
| List all task groups and states | `npm run --silent openlist-tasks -- list all all --compact` |
| Task CLI help (offline) | `npm run --silent openlist-tasks -- --help` |
| Plan one file | `npm run --silent media-plan -- --file "$FILE" --format json --compact` |
| Plan one resource folder | `npm run --silent media-plan -- --source-dir "$OPENLIST_STAGING_PATH" --resource "$RESOURCE_DIR_NAME" --output-file "$PLAN_FILE" --format json --compact` |
| Plan a directory batch | `npm run --silent media-plan -- --source-dir "$DIR" --format json --compact` |
| Archive dry-run (optional) | `npm run --silent media-archive -- --plan-file "$PLAN_FILE" --compact` |
| Execute confirmed archive | `npm run --silent media-archive -- --plan-file "$PLAN_FILE" --yes --compact` (includes fresh preflight) |

## Workflow

### Search and select
1. Search with compact JSON. Normally show 5–10 candidates with title, provider, original share URL, extraction code, and useful quality hints.
2. Preserve original URLs/codes. Do not call link checks unless requested or materially needed.
3. Ask the user to select when multiple plausible candidates exist. Selection and confirmation apply only to the selected resource and operation.
4. After selection, carry forward the exact provider, original share URL, extraction code, and canonical title from that result. Do not search again, rerank, or check links unless the user asks or the selected link has a concrete failure.

### Cloud-drive save
1. Preview every write. Show selected items, provider, actual destination, and rename plan.
2. For a search result, pass its clean title as `--context-name "$CANONICAL_TITLE"`; pass `--resource-type movie` when known. Never derive the canonical title from a noisy share/folder name.
3. Compare selected names with the canonical title. If cleanup is needed but `renamePlan` is empty, do not save; correct the context name or provide a validated rename plan and preview again. Renaming a folder does not rename its children.
4. Execute with `--yes` only after confirmation of exact resource, items, provider, and destination.
5. Baidu save states are `COMPLETED`, `SUBMITTED`, `TRANSFER_SUBMITTED_RENAME_PENDING`, and `SAVED_RENAME_FAILED`. For either submitted state, check the original transfer task first; do not retry the share-save command. Once the transfer is terminal, use the exact `sourcePath` and `renameTo` from compact output with the resume-rename preview command, passing `expectedFsId` as `--expected-id` when available. A target-only match without the expected file ID is reported as `TARGET_EXISTS_UNVERIFIED`, not assumed successful. Execute with `--yes` only after confirmation. `SAVED_RENAME_FAILED` means the transfer request completed but rename failed; recovery never transfers again and refuses to overwrite an existing target.
6. For other providers, documented synchronous terminal success = SUCCEEDED; accepted/task ID = ACTIVE until terminal task status; explicit error = FAILED; ambiguous evidence = UNKNOWN. HTTP 200/202 or accepted is not terminal success for asynchronous providers.
7. Do not relist after clear terminal success. For asynchronous providers, query the original task; never blindly resubmit.
8. On confirmed save execution, reuse the exact preview inputs: provider, share URL, destination, selected items, canonical title, resource type, and rename plan. Do not repeat search or reclassify the resource. If the provider requires a second API read to safely execute, let its CLI perform that check; do not add model-side checks.

### OpenList copy
1. If the OpenList mount is unknown, run `--list-mounts` once; do not run `check-ready`, read `.env`, or write ad-hoc API scripts just to discover mounts. The command returns root mount names and configured staging/library paths in one read-only request.
2. Copy arguments are **source parent directory + item name + destination**. Example: to copy `/百度网盘/影视库/片名`, pass source `/百度网盘/影视库` and name `片名`, not the full item path as the source. If the full item path is mistakenly supplied with its basename, the script checks the parent and safely corrects it only when that exact item exists.
3. Use `OPENLIST_STAGING_PATH` for media ingestion (normally `/本地存储/Downloads`), not the formal Movies/TVShows library. Preview exact source, item name, destination, and conflicts. Execute only after confirmation.
4. Use `--compact` for copy commands. Agent output contains only source, destination, item names, conflicts, status, task ID, and actionable errors; it omits duplicate task/API objects and directory counts. The CLI checks the exact task ID through OpenList's `POST /api/task/copy/info?tid=...` endpoint. A string `state=succeeded` with progress 100 and no contradictory active status is `SUCCEEDED`. For legacy numeric OpenList responses, `state=2` is `SUCCEEDED` only when progress is at least 100, `endTime` is present, `totalBytes` is positive, and there is no error; a stale `status=uploading` is tolerated only with all of that terminal evidence. The directory-dispatch status `src object is dir, added all copy tasks of objs` is never file-copy success; track its child file tasks instead. Pending/running/canceling = `ACTIVE`; explicit error/canceled/errored = `FAILED`; incomplete or ambiguous state = `UNKNOWN`.
5. For task overviews, use one `list` call: `list copy undone` for active copy tasks, `list copy all` for both active and completed copy tasks, or `list all all` for all supported task groups and both states. Use `--compact` to return status counts plus decision fields. For multiple known IDs, use one `get copy --ids "ID1,ID2"`; an individual lookup failure must not prevent results for other IDs. Partial group/state API failures are returned in `queryErrors`; do not silently treat a partial overview as complete. Batch cancel is deliberately not supported with `all` selectors. Do not repeatedly poll, refresh destination, enumerate files, compare sizes, or hash by default. For ACTIVE/UNKNOWN, retain the task ID and query that same task only when the user asks for progress or recovery requires it. Never resubmit blindly.
6. When the copy command returns terminal `SUCCEEDED`, stop the copy stage. Do not issue a separate `openlist-tasks get`, refresh the destination, or enumerate files. For `ACTIVE`/`UNKNOWN`, retain the exact task ID; query it only when the user asks for progress or recovery requires it.

### Media organization
1. Organize only when requested. One named file uses `--file`. One named resource folder uses the staging root plus `--resource "$RESOURCE_DIR_NAME"`; never pass the resource folder itself as `--source-dir`. Use unfiltered `--source-dir` only for a requested batch.
2. For a named resource folder, use `--output-file` to save the complete plan locally. With `--compact`, stdout includes the minimal plan entries and `planFile` in the same response, so the model does not need another command to read the plan. Never parse/rewrite the plan in a shell snippet or hand-edit its summary.
3. Planning is read-only. It identifies media, names, and targets; it does not create directories or mutate files. Archiving does not require an OpenList task ID: a movie downloaded by another tool or copied manually can be archived by its known OpenList file path (`--file`), its containing folder (`--source-dir "$OPENLIST_STAGING_PATH" --resource "$FOLDER_NAME"`), or a one-time staging scan when the exact path is unknown. A task ID is used only when the resource was copied by this workflow and its copy state needs to be established. Planning scans are for locating/classifying media, not for proving download completeness.
4. Generate and preserve one plan. Do not rebuild it, broaden its scope, run a separate preflight by default, or read executor source to rediscover its contract. Use the standalone dry-run only when the user requests preview-only behavior or a separate preflight report.
5. Show the selected resource's exact source/target summary and any `review_required` items. Obtain confirmation of the exact move/rename plan before mutation.
6. A `review_required` item may have a proposed title/type/year/target, but retain original confidence and status. It remains non-executable until the user explicitly confirms that exact item.
7. After confirmation of the exact source/target, annotate only that item with `userConfirmed: true` and matching `confirmation: { "scope": "move-and-rename", "source": "<exact source>", "resourceType": "<movie|series>", "resourceName": "<confirmed title>", "year": <year or null>, "target": "<exact target>" }`. Never raise confidence or change `review_required`. Every field must match exactly; conflicts remain ineligible.
8. Execute the same plan once with `--yes`. This command performs a fresh target-conflict preflight before any mutation, blocks the operation on conflicts, then creates required directories and moves/renames. It does not separately query whether the source exists: the OpenList move API is authoritative and returns an error for a missing/invalid source. Successful OpenList move/rename API responses are the operation completion signal; do not list the target again or perform file-size/hash/content checks. The legacy ledger field `verified: true` means the mutation API returned success, not byte-level integrity verification. Do not run the separate dry-run first when the exact plan has already been reviewed and confirmed.
9. If every executed item returns `apiConfirmed: true` (and legacy `verified: true`), stop. Do not list the destination again, regenerate plans, rescan destinations, or repeat hash/size checks. Preserve multi-season structure; never overwrite same-name targets.

## Token and output discipline

- Read this workflow once per task. Do not repeatedly reread SKILL, SUBAGENT, or provider instructions.
- Routine CLI usage comes from this document, not `scripts/`. Inspect source only for an explicit debugging request or a reproducible failure the docs cannot explain.
- Prefer OpenList task commands with `--compact`; task summaries include counts and decision fields only. Never emit raw task objects, command payloads, signed URLs, or unrelated metadata. Other tools use their documented compact options.
- Capture command output directly. Avoid temporary-file-plus-`head` round trips; save full logs only when output must be retained for debugging, and inspect only relevant excerpts.
- Keep reports to decision/status essentials: resource, provider, source/destination, task ID, status, next action. Do not narrate internal reasoning, repeat command output, or summarize every successful step.
- Durable notes contain only resource, original link, destination, task ID/status, and unresolved next action—not command transcripts or routine details.

## Safety

- Never print, commit, or request credentials, cookies, or authorization headers. Keep `.env` and `.state/` uncommitted.
- Never use `--yes` before confirmation of the exact preview, source, destination, and selected items.
- Confirmation is operation-scoped: cloud save ≠ NAS copy; Downloads copy ≠ formal-library archive.
- Never overwrite/delete existing files or alter the formal library without a separate preview and confirmation.
- Readiness checks and dry-runs are read-only. Directory creation is limited to the configured cloud save path or confirmed archive target.
- Do not create retries, monitoring, cron jobs, or recurring tasks unless requested.
- On timeout/unknown mutation status, query the original task before considering retry.
- `OPENLIST_DEFAULT_COPY_DST_PATH` is generic copy fallback; `OPENLIST_STAGING_PATH` is staging. Do not interchange them. OpenList uses `OPENLIST_BASE_URL` and `OPENLIST_TOKEN`.

## Result vocabulary

- SUBMITTED: write accepted, no terminal task result.
- ACTIVE: task still running.
- SUCCEEDED: clear terminal success.
- FAILED: explicit terminal failure.
- UNKNOWN: no reliable terminal status.

Never call a task complete based only on request acceptance or destination visibility.
