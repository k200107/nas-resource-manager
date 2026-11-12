# Media Planning and Archive Workflow

Read this file for requests to organize, rename, move, or archive media. Shared safety and output rules are in the parent `SKILL.md`.

## Relevant paths

- Staging: `/本地存储/Downloads`
- Movie library: `/本地存储/Movies`
- TV library: `/本地存储/TVShows`

## Commands

| Task | Command |
|---|---|
| Plan one file | `npm run --silent media-plan -- --file "$FILE" --format json --compact` |
| Plan one resource folder | `npm run --silent media-plan -- --source-dir "$OPENLIST_STAGING_PATH" --resource "$RESOURCE_DIR_NAME" --output-file "$PLAN_FILE" --format json --compact` |
| Plan a directory batch | `npm run --silent media-plan -- --source-dir "$DIR" --format json --compact` |
| Archive dry-run (optional) | `npm run --silent media-archive -- --plan-file "$PLAN_FILE" --compact` |
| Execute confirmed archive | `npm run --silent media-archive -- --plan-file "$PLAN_FILE" --yes --compact [--openlist-task-id "$TASK_ID"]` (includes fresh preflight) |

## Workflow

### Media organization
1. Organize only when requested. One named file uses `--file`. One named resource folder uses the staging root plus `--resource "$RESOURCE_DIR_NAME"`; never pass the resource folder itself as `--source-dir`. Use unfiltered `--source-dir` only for a requested batch.
2. For a named resource folder, use `--output-file` to save the complete plan locally. With `--compact`, stdout includes the minimal plan entries and `planFile` in the same response, so the model does not need another command to read the plan. Never parse/rewrite the plan in a shell snippet or hand-edit its summary.
3. Planning is read-only. It identifies media, names, and targets; it does not create directories or mutate files. Archiving does not require an OpenList task ID: a movie downloaded by another tool or copied manually can be archived by its known OpenList file path (`--file`), its containing folder (`--source-dir "$OPENLIST_STAGING_PATH" --resource "$FOLDER_NAME"`), or a one-time staging scan when the exact path is unknown. A task ID is used only when the resource was copied by this workflow and its copy state needs to be established. Planning scans are for locating/classifying media, not for proving download completeness. Compact planning output distinguishes scanned files/directories from planned video files; if `summary.unplannedVideoFiles` is non-empty, stop and investigate those exact source paths instead of assuming the scan is complete.
4. Generate and preserve one plan. Do not rebuild it, broaden its scope, run a separate preflight by default, or read executor source to rediscover its contract. Use the standalone dry-run only when the user requests preview-only behavior or a separate preflight report.
5. Show the selected resource's exact source/target summary and any `review_required` items. Confirm that every scanned video file is represented in the plan; if `summary.unplannedVideoFiles` is non-empty, do not archive until resolved. Obtain confirmation of the exact move/rename plan before mutation.
6. A `review_required` item may have a proposed title/type/year/target, but retain original confidence and status. It remains non-executable until the user explicitly confirms that exact item.
7. After confirmation of the exact source/target, annotate only that item with `userConfirmed: true` and matching `confirmation: { "scope": "move-and-rename", "source": "<exact source>", "resourceType": "<movie|series>", "resourceName": "<confirmed title>", "year": <year or null>, "target": "<exact target>" }`. Never raise confidence or change `review_required`. Every field must match exactly; conflicts remain ineligible.
8. Execute the same plan once with `--yes`. This command performs a fresh target-conflict preflight before any mutation, blocks the operation on conflicts, then creates required directories and moves/renames. It does not separately query whether the source exists: the OpenList move API is authoritative and returns an error for a missing/invalid source. Successful OpenList move/rename API responses are the operation completion signal; do not list the target again or perform file-size/hash/content checks. The legacy ledger field `verified: true` means the mutation API returned success, not byte-level integrity verification. Do not run the separate dry-run first when the exact plan has already been reviewed and confirmed.
9. If the archive was triggered by an OpenList copy task, pass its exact task ID with `--openlist-task-id "$TASK_ID"` to persist the association in the existing archive ledger. For a resource archived before this feature, rerun its saved plan once with `--openlist-task-id "$TASK_ID"` and without `--yes`; the task ID is linked only if the exact source/target pair is already recorded as archived. Then routine task listings can use `--exclude-archived`.
10. If every executed item returns `apiConfirmed: true` (and legacy `verified: true`), stop. Do not list the destination again, regenerate plans, rescan destinations, or repeat hash/size checks. Preserve multi-season structure; never overwrite same-name targets.

## Source and completion rules

- A media-archive request does not require an OpenList task ID. If the file came from another downloader, manual copy, or another workflow, use its known OpenList file path; if the exact path is unknown, perform one scoped staging scan to locate/classify the requested title.
- A scan is for locating and classifying media, not a separate file-existence or completeness verification. Do not add file-size/hash/playability checks by default.
- If archive is automatically chained from this skill's OpenList copy workflow, require terminal `SUCCEEDED` for each actual file-copy task first. Do not infer success from a parent directory-dispatch task, destination visibility, or a plan scan.
- The archive executor's move/rename API response is authoritative for the archive operation. On API success, stop; do not relist the destination or recheck file existence.


## Efficient diagnostics

- Use the documented `media-plan` commands and compact JSON output; do not probe unsupported `--help` flags or read implementation files to rediscover options.
- Do not create ad-hoc scripts that import internal OpenList modules just to inspect a directory. If the scoped planner output cannot answer a question, report the limitation and use an existing documented command; only add a reusable CLI after a separate reviewed change.
- For year-bearing folders, check file coverage rather than comparing `scannedItems` with plan length: scanned items include directories and sidecars.
