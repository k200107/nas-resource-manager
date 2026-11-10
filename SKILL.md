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
| OpenList copy preview | `npm run --silent openlist-copy -- "$SRC" "$DST" "$NAME" --format json` |
| Provider save after confirmation | Same provider command with `--yes`, retaining naming arguments and compact JSON |
| OpenList copy after confirmation | Same copy command with `--yes` |
| Inspect copy task | `npm run --silent openlist-tasks -- get copy --id "$TASK_ID" --format json` |
| Plan one file | `npm run --silent media-plan -- --file "$FILE" --format json --compact` |
| Plan a directory | `npm run --silent media-plan -- --source-dir "$DIR" --format json --compact` |
| Archive preflight | `npm run --silent media-archive -- --plan-file "$PLAN_FILE" --compact` |
| Execute reviewed archive | Same archive command with `--yes --compact` after confirmation |

## Workflow

### Search and select
1. Search with compact JSON. Normally show 5–10 candidates with title, provider, original share URL, extraction code, and useful quality hints.
2. Preserve original URLs/codes. Do not call link checks unless requested or materially needed.
3. Ask the user to select when multiple plausible candidates exist. Selection and confirmation apply only to the selected resource and operation.

### Cloud-drive save
1. Preview every write. Show selected items, provider, actual destination, and rename plan.
2. For a search result, pass its clean title as `--context-name "$CANONICAL_TITLE"`; pass `--resource-type movie` when known. Never derive the canonical title from a noisy share/folder name.
3. Compare selected names with the canonical title. If cleanup is needed but `renamePlan` is empty, do not save; correct the context name or provide a validated rename plan and preview again. Renaming a folder does not rename its children.
4. Execute with `--yes` only after confirmation of exact resource, items, provider, and destination.
5. Status: documented synchronous terminal success = SUCCEEDED; accepted/task ID = ACTIVE until terminal task status; explicit error = FAILED; ambiguous evidence = UNKNOWN. HTTP 200/202 or accepted is not terminal success for asynchronous providers.
6. Do not relist after clear terminal success. For asynchronous providers, query the original task; never blindly resubmit.

### OpenList copy
1. Preview exact source, item name, destination, and conflicts. Execute only after confirmation.
2. Check the exact task ID once: undone = ACTIVE; done with no error = SUCCEEDED; explicit error = FAILED; absent from both lists = UNKNOWN.
3. Do not repeatedly poll, refresh destination, enumerate files, compare sizes, or hash by default. For ACTIVE/UNKNOWN, retain the task ID and query that same task when progress is requested. Never resubmit blindly.

### Media organization
1. Organize only when requested. One named file uses `--file`; `--source-dir` is only for a requested directory/batch.
2. Planning is read-only: identify media, names, and targets only. It does not scan Movies/TVShows for conflicts or create directories. Archive preflight checks source existence and exact target collisions.
3. Generate and preserve one plan. Do not rebuild it, broaden its scope, or read executor source to rediscover its contract.
4. Run archive preflight against that plan and show exact source/target and conflicts before confirmation.
5. A `review_required` item may have a proposed title/type/year/target, but retain original confidence and status. Preflight it; it remains non-executable until confirmed.
6. After confirmation of the exact source/target, annotate only that item with `userConfirmed: true` and matching `confirmation: { "scope": "move-and-rename", "source": "<exact source>", "resourceType": "<movie|series>", "resourceName": "<confirmed title>", "year": <year or null>, "target": "<exact target>" }`. Never raise confidence or change `review_required`. Every field must match exactly; conflicts remain ineligible.
7. Execute the same plan with `--yes`. The executor repeats preflight immediately before mutation, creates missing target directories only during confirmed execution, then moves/renames, verifies the target, and records the idempotency ledger.
8. Do not regenerate plans, rescan destinations, or repeat hash/size checks after verified success. Preserve multi-season structure; never overwrite same-name targets.

## Token and output discipline

- Read this workflow once per task. Do not repeatedly reread SKILL, SUBAGENT, or provider instructions.
- Routine CLI usage comes from this document, not `scripts/`. Inspect source only for an explicit debugging request or a reproducible failure the docs cannot explain.
- Use compact JSON for search/provider saves and compact media-plan/archive output. Do not print or forward full JSON when compact output contains the needed fields.
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
