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
| OpenList copy preview | npm run openlist-copy -- "$SRC" "$DST" "$NAME" --format json |
| Provider save after confirmation | Same provider command with --yes --format json --compact (retain --context-name and --resource-type) |
| OpenList copy after confirmation | Same command with --yes --format json |
| Inspect copy tasks | npm run openlist-tasks -- get copy --id "$TASK_ID" --format json |

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
6. Copy to NAS: preview source, exact item name, destination, and conflicts. After confirmation, run fs/copy through openlist-copy.
7. Copy status: use the exact returned task ID. One task snapshot is enough: task in undone = ACTIVE; task in done with no error = SUCCEEDED; explicit error = FAILED; task missing from both = UNKNOWN. Do not repeatedly poll, refresh the destination, enumerate every copied file, compare sizes, or calculate hashes by default.
8. Organize: only when requested. Plan destination and conflicts first. Moving/renaming into Movies or TVShows requires separate explicit confirmation.

## Token-efficient rules

- For Agent search and all provider save previews/results, use --format json --compact. Compact provider output omits duplicated confirmation payloads and raw task metadata while retaining source, target, selected items, rename plan, task ID, and status. This returns one flat row per result without duplicate nested candidate/download-link structures.
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
