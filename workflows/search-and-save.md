# Search and Cloud-drive Save Workflow

Read this file only for media search, candidate selection, or cloud-drive save tasks. Shared safety and output rules are in the parent `SKILL.md`.

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
| Provider save after confirmation | Same provider command with `--yes`, retaining naming arguments and compact JSON |

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
