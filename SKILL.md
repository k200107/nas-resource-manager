---
name: resource-2-nas
description: Search media resources, save Aliyun/Quark/Baidu shares, copy them through OpenList to NAS, inspect tasks, and plan media organization.
---

# Resource 2 NAS

Use this skill for media search, cloud-drive share saving, OpenList task inspection/copy, and media organization.

## Defaults

- Search provider order: Aliyun → Quark → Baidu. Only choose a provider listed as usable by the relevant readiness check.
- Search returns 10 candidates by default. Use --max-candidates 30 only when the user asks for more.
- Search already deduplicates by share link and interleaves providers, so the 10 rows normally span several providers. Check `providerAvailable` before concluding a provider has no results.
- Cloud-drive save folder: provider-specific save path, default /影视库.
- Media copy staging folder: /本地存储/Downloads.
- Final libraries: /本地存储/Movies and /本地存储/TVShows.
- Generic copy fallback: /本地存储.
- Cloud-drive /影视库 and OpenList /本地存储/... are different storage systems.
- Missing cloud-drive save folders appear in `willCreateDirectories` during preview. Folders are created only after the user confirms the exact preview and the command reruns with `--yes`; existing folders are reused, never overwritten. `--no-create-dir` restores the fail-fast behaviour.

## Commands

| Task | Command |
|---|---|
| Search for agent | npm run search -- "片名" --format json --compact |
| Search for user display | npm run search -- "片名" --max-candidates 10 |
| Readiness (first setup or after auth/path error) | npm run check-ready |
| Focused env check | npm run check-env -- --json |
| Aliyun preview | npm run aliyun-save -- "$URL" "$DEST" --context-name "$CANONICAL_TITLE" --resource-type movie --dry-run --format json --compact |
| Quark preview | npm run quark-save -- "$URL" "$DEST" --dry-run --format json --compact |
| Baidu preview | npm run baidu-save -- "$URL" "$DEST" --dry-run --format json --compact |
| OpenList copy preview | npm run openlist-copy -- --source-item-path "$SOURCE_ITEM_PATH" --dst-dir "$DST" --format json --compact |
| Provider save after confirmation | Same provider command with --yes --format json --compact (retain --context-name and --resource-type) |
| OpenList copy after confirmation | Same command with --yes --format json --compact |
| Inspect copy tasks | npm run openlist-tasks -- get copy --id "$TASK_ID" --format json --compact |
| Plan one downloaded file | npm run --silent media-plan -- --file "$FILE" --format json --compact |
| Plan a staging directory | npm run --silent media-plan -- --source-dir "$DIR" --format json --compact |
| Plan one selected resource from a directory | npm run --silent media-plan -- --source-dir "$DIR" --resource "$RESOURCE_NAME" --output-file "$PLAN_FILE" |
| Archive preflight | npm run --silent media-archive -- --plan-file "$PLAN_FILE" --compact |
| Execute reviewed archive | Same archive command with --yes --compact after the exact plan is confirmed |

## Minimal workflow

1. Search: use compact JSON for Agent decisions. Deduplicate by provider + share URL. Show a short list (normally 5–10) with title, provider, link, extraction code, and relevant quality hints.
   Compact output already deduplicates and reports `providerAvailable`; only re-check for duplicates when a provider appears twice with the same share id.
2. Select: ask the user to select a resource when multiple plausible candidates exist. Confirmation applies only to the selected resource and stated operation.
3. Preview save: run the provider dry-run. Show selected items and actual destination before a write.
4. Save preview naming: when the selected resource came from search, pass the clean canonical title from that search result explicitly with `--context-name "$CANONICAL_TITLE"`; do not derive the final name from a noisy share/folder name. For a movie, also pass `--resource-type movie` when the type is known. Before asking for confirmation, compare the selected folder/file name with the canonical title and inspect `renamePlan`. If a noisy folder should be renamed but `renamePlan` is empty, do not run `--yes`; rerun the preview with the canonical `--context-name` (or a validated `--rename-plan-json`). Renaming a selected folder changes only that folder's name; it does not rename files inside it.
5. Save: after explicit confirmation, rerun with --yes. Interpret provider results:
   - Documented synchronous terminal success = SUCCEEDED.
   - Accepted response or task ID = ACTIVE until the provider task reports terminal success.
   - Explicit API error = FAILED.
   - Missing/ambiguous task evidence = UNKNOWN.
   Do not re-list every saved file after clear terminal success. Do not treat generic HTTP 200/202 or accepted as terminal success when the provider uses asynchronous tasks.
6. Copy to NAS: derive one exact OpenList item path from the provider mount path + saved cloud-drive folder + selected item name. Pass it once with --source-item-path; the script derives its parent directory and basename. Do not pass the item name again or append it twice. Preview with --compact to show source, destination, selected item, and conflicts. After confirmation, rerun the same command with --yes.
7. Copy status: use the exact returned task ID. One task snapshot is enough: task in undone = ACTIVE; task in done with no error = SUCCEEDED; explicit error = FAILED; task missing from both = UNKNOWN. Do not repeatedly poll, refresh the destination, enumerate every copied file, compare sizes, or calculate hashes by default.
8. Organize: only when requested.
   - If the user names one file, use `media-plan --file "$FILE" --format json --compact`; do not scan the whole Downloads directory. Use `--source-dir` only when the user asks to organize/check a directory or multiple resources.
   - Planning is strictly read-only and only identifies media/names/targets; it does not query Movies/TVShows for conflicts or create directories. Conflict checking belongs to `media-archive` preflight, which checks source existence and exact target collisions. Before filesystem preflight, `media-archive` reads `/api/task/copy/undone` once and blocks any active source/resource group (including its sidecars); do not add a separate manual task-list query. If the task-list check fails, archive fails closed.
   - Generate one plan and preserve it. For a multi-resource directory, use `--resource "$RESOURCE_NAME" --output-file "$PLAN_FILE"` to write the exact filtered plan locally; the command returns only a compact summary. Pass that file directly to `media-archive`. Do not manually parse/rebuild the JSON, create a second temporary plan, or reread executor source to discover its contract.
   - If a review-required item has no target, propose its canonical title, resource type, year and target in that same plan, but keep its original `confidence` and `status: "review_required"`. Run archive preflight against the single preserved plan before asking for confirmation. The executor preflights both automatic candidates and `review_required` items that have a proposed source, resource type and target; review items remain non-executable and are reported in `awaitingUserConfirmation`. Use `--compact` for both preflight and execution output.
   - After the user confirms the exact source/target preview and preflight, automatic candidates can execute. For each confirmed `review_required` item, preserve its original `confidence` and `status`; annotate that same item with `userConfirmed: true` and `confirmation: { "scope": "move-and-rename", "source": "<exact source>", "resourceType": "<movie|series>", "resourceName": "<confirmed canonical title>", "year": <confirmed year or null>, "target": "<exact target>" }`. Never change low/medium confidence to high to bypass review.
   - The archive executor accepts a reviewed item for execution only when the confirmation record matches its exact source, resource type, canonical title, target and year. Conflicts are never made eligible by confirmation.
   - Execute that same plan with `--yes`; the executor repeats the source/target preflight immediately before mutation. Do not regenerate or broaden the plan, and do not ask for a second confirmation of an unchanged preview.
   - The executor creates missing target directories only during confirmed execution, then moves/renames, checks the resulting target, and records the idempotency ledger. Do not repeat destination scans or hash/size checks after a verified success.

## Token-efficient rules

- For Agent search and all provider save previews/results, use --format json --compact. Compact search output keeps only totals needed for result interpretation, provider availability, and each candidate's title/provider/link/code; diagnostic counters, duplicate source metadata, and placeholder timestamps are omitted. Compact provider output omits duplicated confirmation payloads and raw task metadata while retaining source, target, selected items, rename plan, task ID, and status.
- For OpenList copy, use --format json --compact. The compact result keeps the exact source item, destination, conflicts, target paths, and task status/ID without repeating the same paths in source, copyPlan, and confirmation objects.
- If the host Agent maintains a daily memory log, record only the resource title, provider, final cloud/NAS path, terminal status/task ID, and unresolved next action. Do not store candidate dumps, retry traces, raw JSON, or the confirmation transcript.
- Default to 10 candidates. Expand only on request.
- Do not call --check-links unless the user asks for link verification or the result set is unusually uncertain.
- Run full check-ready only on first setup or after an authentication/path failure. During normal use, let the selected provider/OpenList call report a concrete error; then run only the relevant focused check.
- Do not re-read SKILL, SUBAGENT, and all provider instructions repeatedly within one task. Read the applicable workflow once; load provider details only when needed.
- Do not repeat a verification merely to produce a more detailed report. Report API/task status and its evidence.
- For a named archive file, plan only that file. Use `--compact` for both media-plan and media-archive; do not pass full formatted JSON when compact output contains the execution contract and outcome evidence.
- Read the applicable skill workflow once. Do not inspect implementation source unless a real command failure or missing documented contract requires it.

## Safety

- Never print, commit, or request raw credentials, cookies, or authorization headers. .env and .state/ must remain uncommitted.
- Never use --yes before the user or supervising Agent confirms the exact preview payload, source, destination, and selected items.
- Confirmation is scoped: confirming cloud save does not authorize NAS copy; confirming Downloads copy does not authorize archive into Movies/TVShows.
- Never overwrite or delete existing files, or modify the formal media library without a separate preview and confirmation.
- Automatic directory creation is scoped to the configured save path. A dry-run and every readiness check stay read-only.
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
